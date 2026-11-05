// Local-only setup. Never copies credentials or data from another installation.
import {readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const major=Number(process.versions.node.split('.')[0]);
if(major<24) throw new Error('Install Node.js 24 or newer before running local setup.');
const path=fileURLToPath(new URL('../.env',import.meta.url));
let text=existsSync(path)?readFileSync(path,'utf8'):'';
const values={
 HOST:'127.0.0.1',PORT:'4191',PUBLIC_URL:'http://127.0.0.1:4191',AUTH_MODE:'accounts',AI_PROVIDER:'offline',
 LOCAL_SKIP_EMAIL_VERIFICATION:'true',
 ALLOWED_EMAILS:'khushi.sharma.2201@gmail.com,sidmehta927@gmail.com,paroksh05@gmail.com,parokshvashistha@gmail.com',
 SMTP_ALLOWED_HOSTS:'smtp.gmail.com,smtp.office365.com',
 MAILBOX_KEY:randomBytes(32).toString('base64')
};
if(/^NODE_ENV\s*=\s*["']?production/m.test(text)||process.env.NODE_ENV==='production'||process.env.VERCEL) throw new Error('This command is for local development only.');
for(const [name,value] of Object.entries(values)){
 const re=new RegExp('^'+name+'=(.*)$','m'),m=text.match(re);
 if(name==='ALLOWED_EMAILS'&&m){
  const addresses=[...new Set([...m[1].replace(/^["']|["']$/g,'').split(',').map(x=>x.trim().toLowerCase()),...value.split(',')].filter(Boolean))];
  text=text.replace(re,()=>name+'='+addresses.join(','));
 }else if(!m||!m[1].trim()){
  text=m?text.replace(re,()=>name+'='+value):text+'\n'+name+'='+value+'\n';
 }
}
writeFileSync(path,text,{mode:0o600});chmodSync(path,0o600);
console.log('Local setup complete. Existing settings and encryption keys were preserved. Run npm start. No credentials were printed.');
