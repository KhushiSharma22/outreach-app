// Customer SMTP credentials are isolated from transactional authentication email.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { invalid, AppError, EMAIL_RE } from './lib.mjs';
import { now } from './db.mjs';
function key() {
  const k = Buffer.from(process.env.MAILBOX_KEY || '', 'base64');
  if (k.length !== 32 || !/^[A-Za-z0-9+/]{43}=$/.test(process.env.MAILBOX_KEY || '')) throw new AppError(503, 'mailbox_key', 'Mailbox encryption is not configured by the operator.');
  return k;
}
export function encrypt(value, workspace) { const iv=randomBytes(12), c=createCipheriv('aes-256-gcm',key(),iv); c.setAAD(Buffer.from(workspace)); const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]); return 'v2.'+[iv,c.getAuthTag(),data].map(x=>x.toString('base64')).join('.'); }
export function decrypt(value, workspace) { if(!value.startsWith('v2.')) throw invalid('Reconnect this mailbox to upgrade credential protection.'); const [iv,tag,data]=value.slice(3).split('.').map(x=>Buffer.from(x,'base64')); const d=createDecipheriv('aes-256-gcm',key(),iv); d.setAAD(Buffer.from(workspace)); d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(data),d.final()])); }
export async function status(ctx) { const r=await ctx.db.get('SELECT sender, postal_address, updated_at FROM mailboxes WHERE workspace_id=?',[ctx.ws]); return r || {sender:null}; }
export async function transport(ctx) {
 const r=await ctx.db.get('SELECT * FROM mailboxes WHERE workspace_id=?',[ctx.ws]); if(!r) throw invalid('Connect your SMTP mailbox first.');
 let c; try { c=decrypt(r.credentials,ctx.ws); } catch { throw new AppError(503,'mailbox_unavailable','Mailbox credentials cannot be opened. Ask the operator to check the encryption key or reconnect.'); }
 if(!(process.env.SMTP_ALLOWED_HOSTS||'').split(',').map(x=>x.trim().toLowerCase()).includes(c.host)) throw invalid('SMTP provider is no longer approved. Contact the operator.');
 const {default:nodemailer}=await import('nodemailer');
 return {row:r, client:nodemailer.createTransport({...c, secure:c.port===465, requireTLS:true, tls:{rejectUnauthorized:true}, connectionTimeout:10000, socketTimeout:20000, disableFileAccess:true, disableUrlAccess:true})};
}
// Classify provider failures without returning raw responses, credentials or addresses.
export function connectionFailure(error, stage) {
 const code=error?.code;
 let message;
 if(code==='EAUTH') message='SMTP login was rejected. Check the full mailbox username and use a provider-issued app password. For Gmail, check that app passwords are enabled for this Google account.';
 else if(['ETIMEDOUT','ECONNECTION','ESOCKET','ECONNREFUSED','EDNS','ENOTFOUND','EAI_AGAIN'].includes(code)) message='Could not reach the SMTP server. Check the hostname, port and your network or firewall, then retry.';
 else if(['ETLS','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) message='The secure SMTP connection could not be verified. Check the provider hostname and certificate configuration.';
 else if(stage==='send') message='SMTP login succeeded, but the test email was not confirmed as accepted. Check sender permission and provider sending limits; check your inbox before retrying.';
 else message='SMTP verification failed. Check provider settings, app password and whether SMTP access is enabled.';
 return invalid(message+' Your previous connection has not been changed.');
}
export async function connect(ctx,body, createTransport) {
 if(ctx.user?.role!=='owner') throw new AppError(403,'owner_only','Only a workspace owner can configure email.');
 await ctx.db.tx(async()=>{
 await ctx.db.run('UPDATE workspaces SET name=name WHERE id=?',[ctx.ws]);
 const rateKey='mailbox:'+ctx.ws;
 const hits=await ctx.db.get('SELECT count(*) n FROM rate_limit_hits WHERE key=? AND at>?',[rateKey,new Date(Date.now()-3600000).toISOString()]);
 if(Number(hits.n)>=5) throw new AppError(429,'mailbox_rate_limit','Wait before testing again: five connection attempts per hour.');
 await ctx.db.insert('rate_limit_hits',{key:rateKey,at:now()});
 });
 const host=String(body.host||'').trim().toLowerCase(), port=Number(body.port), sender=String(body.sender||'').trim().toLowerCase();
 // Operator-approved hosts prevent arbitrary internal-network access through SMTP setup.
 const hosts=(process.env.SMTP_ALLOWED_HOSTS||'').split(',').map(s=>s.trim().toLowerCase());
 if(![465,587].includes(port)) throw invalid('SMTP port must be 465 (TLS) or 587 (STARTTLS). Enter only the number.');
 if(!hosts.filter(Boolean).length) throw invalid('No SMTP providers are configured on this server. Set SMTP_ALLOWED_HOSTS in this installation’s .env and restart the backend.');
 if(!hosts.includes(host)) throw invalid('SMTP host is not approved on this server. Approved hosts: '+hosts.filter(Boolean).join(', ')+'. Enter the hostname only, without https:// or a port. Ask the operator to approve a different provider.');
 if(!EMAIL_RE.test(sender)||!body.user||!body.password||!String(body.postal_address||'').trim()) throw invalid('Sender, username, app password and business postal address are required.');
 if(String(body.password).length>1024||String(body.user).length>320||/[\r\n]/.test(sender)) throw invalid('Invalid SMTP credentials.');
 const context=await ctx.db.get('SELECT data FROM account_context_versions WHERE workspace_id=? ORDER BY version DESC LIMIT 1',[ctx.ws]);
 const company=JSON.parse(context?.data||'{}');
 if(!company.offering||!company.icp) throw invalid('Save your company context before connecting email.');
 if(sender!==String(company.email||'').toLowerCase()) throw invalid('Use the sender email saved in Company context.');
 const credentials=encrypt({host,port,auth:{user:String(body.user),pass:String(body.password)}},ctx.ws);
 const factory=createTransport || (await import('nodemailer')).default.createTransport;
 const client=factory({host,port,secure:port===465,requireTLS:true,auth:{user:String(body.user),pass:String(body.password)},connectionTimeout:10000,socketTimeout:20000,tls:{rejectUnauthorized:true}});
 let stage='verify';
 try {await client.verify(); stage='send'; await client.sendMail({from:sender,to:sender,subject:'Outbound mailbox connection test',text:'Your SMTP settings were verified. This test checks sending from your configured address. No campaign has been launched.',disableFileAccess:true,disableUrlAccess:true});} catch (error) {throw connectionFailure(error,stage);} finally {client.close();}
 await ctx.db.run('INSERT INTO mailboxes(workspace_id, sender, postal_address, credentials, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET sender=excluded.sender, postal_address=excluded.postal_address, credentials=excluded.credentials, updated_at=excluded.updated_at',[ctx.ws,sender,String(body.postal_address).trim().slice(0,500),credentials,now()]);
 await ctx.db.audit(ctx.ws,null,'mailbox.connected','SMTP connection tested and saved',{},ctx.user.id);
 return status(ctx);
}
