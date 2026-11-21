// Campaign-specific supply. Customers import their own contacts; operators prepare research lists.
import {id,now} from './db.mjs';
import {invalid,conflict,parseCsv,EMAIL_RE,localView} from './lib.mjs';
import {loadCampaign} from './campaigns.mjs';
import {importCsv,checkCandidate} from './sourcing.mjs';
import {planWeeklySlots} from './weekly-plan.mjs';
import {addDays,weekdayOf} from './lib.mjs';
const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
export function previewUpload({csv}) {
 if(typeof csv!=='string'||csv.length>5_000_000)throw invalid('Choose a CSV file up to 5 MB.');
 const rows=parseCsv(csv), headers=(rows.shift()||[]).map(h=>h.replace(/^\uFEFF/,'').trim().toLowerCase());
 if(!rows.length||rows.length>5000)throw invalid('Upload between 1 and 5,000 contacts.');
 if(new Set(headers).size!==headers.length)throw invalid('CSV column names must be unique.');
 for(const h of ['first_name','last_name','email','company'])if(!headers.includes(h))throw invalid('Required columns: first_name, last_name, email, company. Download the template to get started.');
 const seen=new Set(),errors=[],accepted=[],preview=[];let duplicates=0;
 rows.forEach((r,i)=>{
 const get=k=>String(r[headers.indexOf(k)]||'').trim();const email=get('email').toLowerCase();
 if(r.length!==headers.length||!get('first_name')||!get('company')||!EMAIL_RE.test(email)){errors.push({line:i+2,reason:'Check the column count, first name, company and email address.'});return;}
 if(seen.has(email)){duplicates++;return;}seen.add(email);
 // Customer assertions never establish email verification or replace operator evidence.
 const keys=['first_name','last_name','email','company','role','domain','industry','employees','location','linkedin_url'];
 const safe=Object.fromEntries(keys.map(k=>[k,k==='email'?email:get(k)]));accepted.push(safe);
 if(preview.length<5)preview.push(safe);
 });
 return {total:rows.length,valid:accepted.length,duplicates,errors,preview,accepted};
}
const safeCsv=rows=>{const keys=['first_name','last_name','email','company','role','domain','industry','employees','location','linkedin_url'];return [keys,...rows.map(r=>keys.map(k=>r[k]))].map(r=>r.map(quote).join(',')).join('\n');};
export async function uploadForCampaign(ctx,campaignId,body){
 const c=await loadCampaign(ctx,campaignId);if(c.status==='stopped')throw conflict('campaign_stopped','This campaign is stopped.');
 const p=previewUpload(body);if(p.errors.length)throw invalid('Fix the invalid rows before importing.',{rows:p.errors.slice(0,100)});
 if(!p.valid)throw invalid('No valid contacts to import.');
 const ids=[];let imported;
 await ctx.db.tx(async()=>{
 imported=await importCsv(ctx,{filename:body.filename||'My contacts.csv',csv:safeCsv(p.accepted)},ids);
 for(const contactId of ids)await ctx.db.run(`INSERT INTO campaign_contact_pool(workspace_id,campaign_id,contact_id,source,available_on,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(campaign_id,contact_id,source) DO NOTHING`,[ctx.ws,c.id,contactId,'upload',now().slice(0,10),now()]);
 });
 return {...imported,duplicates:p.duplicates,linked:ids.length};
}
async function candidates(ctx,c,source,day){
 return ctx.db.all(`SELECT ct.*,co.name company,co.domain,co.industry,co.employees,co.location company_location,co.relationship,s.reason suppressed,
 (SELECT c2.name FROM messages m JOIN campaigns c2 ON c2.id=m.campaign_id WHERE m.contact_id=ct.id AND m.campaign_id<>? LIMIT 1) other_campaign
 FROM campaign_contact_pool p JOIN contacts ct ON ct.id=p.contact_id AND ct.workspace_id=p.workspace_id JOIN companies co ON co.id=ct.company_id
 LEFT JOIN suppressions s ON s.workspace_id=ct.workspace_id AND s.email=ct.email
 WHERE p.workspace_id=? AND p.campaign_id=? AND p.source=? AND p.available_on<=?
 AND NOT EXISTS(SELECT 1 FROM campaign_contact_claims x WHERE x.workspace_id=p.workspace_id AND x.contact_id=p.contact_id)
 AND NOT EXISTS(SELECT 1 FROM pilot_contacts x WHERE x.workspace_id=p.workspace_id AND x.contact_id=p.contact_id)
 AND NOT EXISTS(SELECT 1 FROM campaign_leads l WHERE l.campaign_id=p.campaign_id AND l.contact_id=p.contact_id)
 ORDER BY p.available_on,p.created_at,ct.id LIMIT 5000`,[c.id,ctx.ws,c.id,source,day]);
}
export async function assessPrepared(ctx,c,cand,evidence,score=null,preloaded=false){
 if(score===null&&!preloaded){const approved=await ctx.db.get('SELECT score FROM research_approvals WHERE workspace_id=? AND campaign_id=? AND contact_id=?',[ctx.ws,c.id,cand.id]);score=approved?.score??null;}
 const result=checkCandidate(ctx,{...c.config,requireVerifiedEmail:true,...(score!==null?{quality:0}:{})},c.context.data,cand,evidence,localView(Date.now(),c.config.schedule.timezone||'UTC').date);
 if(score!==null){result.score=score;if(result.decision==='qualified'&&score<c.config.quality)result.decision='review';result.rationale='Admin quality score: '+score+'/100. '+result.rationale;}
 return result;
}
async function assessed(ctx,c,cand,score=null){
 const evidence=await ctx.db.all('SELECT * FROM evidence WHERE workspace_id=? AND (contact_id=? OR (company_id=? AND contact_id IS NULL))',[ctx.ws,cand.id,cand.company_id]);
 // Research lists must have verified email even if the user relaxes that requirement for uploads.
 return assessPrepared(ctx,c,cand,evidence,score);
}
// Load shared evidence and admin scores once for a campaign instead of querying per candidate.
async function assessCandidates(ctx,c,list){
 if(!list.length)return new Map();
 const scores=await ctx.db.all('SELECT contact_id,score FROM research_approvals WHERE workspace_id=? AND campaign_id=?',[ctx.ws,c.id]);
 const evidence=await ctx.db.all(`SELECT p.contact_id pool_contact_id,e.* FROM campaign_contact_pool p JOIN contacts ct ON ct.id=p.contact_id AND ct.workspace_id=p.workspace_id JOIN evidence e ON e.workspace_id=ct.workspace_id AND (e.contact_id=ct.id OR (e.company_id=ct.company_id AND e.contact_id IS NULL)) WHERE p.workspace_id=? AND p.campaign_id=? AND p.source='research'`,[ctx.ws,c.id]);
 const byScore=new Map(scores.map(x=>[x.contact_id,x.score])),byEvidence=new Map();
 for(const e of evidence){const {pool_contact_id,...item}=e;const entries=byEvidence.get(pool_contact_id)||[];entries.push(item);byEvidence.set(pool_contact_id,entries);}
 const out=new Map();for(const cand of list)out.set(cand.id,await assessPrepared(ctx,c,cand,byEvidence.get(cand.id)||[],byScore.get(cand.id)??null,true));
 return out;
}
// Trusted CLI and super-admin endpoint only. Customer routes cannot seed research.
export async function seedResearch(ctx,campaignId,{csv,filename='Research list',available_on=now().slice(0,10)}){
 const c=await loadCampaign(ctx,campaignId);
 if(c.status==='stopped')throw conflict('campaign_stopped','This campaign is stopped.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(available_on)||!Number.isFinite(Date.parse(available_on))||new Date(available_on).toISOString().slice(0,10)!==available_on)throw invalid('Use an availability date in YYYY-MM-DD format.');
 const rows=parseCsv(csv),headers=(rows.shift()||[]).map(h=>h.trim().toLowerCase()),scoreIndex=headers.indexOf('quality_score'),emailIndex=headers.indexOf('email');
 const scores=new Map();for(const row of rows){const raw=scoreIndex<0?'100':String(row[scoreIndex]||'').trim();const score=Number(raw);if(!raw||!Number.isInteger(score)||score<0||score>100)throw invalid('quality_score must be an integer from 0 to 100.');scores.set(String(row[emailIndex]||'').trim().toLowerCase(),score);}
 const ids=[],rejected=[];let imported,ready=0;
 await ctx.db.tx(async()=>{
 imported=await importCsv(ctx,{csv,filename},ids);
 for(const contactId of [...new Set(ids)]){
 const cand=await ctx.db.get(`SELECT ct.*,co.name company,co.domain,co.industry,co.employees,co.location company_location,co.relationship,s.reason suppressed FROM contacts ct JOIN companies co ON co.id=ct.company_id LEFT JOIN suppressions s ON s.workspace_id=ct.workspace_id AND s.email=ct.email WHERE ct.id=? AND ct.workspace_id=?`,[contactId,ctx.ws]);
 const score=scores.get(cand.email)??100;
 const result=await assessed(ctx,c,cand,score);
 if(result.decision!=='qualified'){rejected.push({contact_id:contactId,reason:result.rationale});continue;}
 await ctx.db.run('INSERT INTO research_approvals(workspace_id,campaign_id,contact_id,score,approved_by,approved_at) VALUES(?,?,?,?,?,?) ON CONFLICT(campaign_id,contact_id) DO UPDATE SET score=excluded.score,approved_by=excluded.approved_by,approved_at=excluded.approved_at',[ctx.ws,c.id,contactId,score,ctx.user?.id,now()]);
 await ctx.db.run(`INSERT INTO campaign_contact_pool(workspace_id,campaign_id,contact_id,source,available_on,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(campaign_id,contact_id,source) DO UPDATE SET available_on=excluded.available_on`,[ctx.ws,c.id,contactId,'research',available_on,now()]);ready++;
 }
 await ctx.db.audit(ctx.ws,c.id,'research.prepared','Research availability updated',{ready,rejected:rejected.length},ctx.user?.id);
 });return {import:imported,ready,rejected};
}
export async function sourceStatus(ctx,campaignId){
 const c=await loadCampaign(ctx,campaignId),day=now().slice(0,10);
 const allocation=await ctx.db.get('SELECT * FROM research_days WHERE workspace_id=? AND day=?',[ctx.ws,day]);
 const list=await candidates(ctx,c,'research',day),assessments=await assessCandidates(ctx,c,list);let ready=0;
 for(const cand of list)if(assessments.get(cand.id).decision==='qualified')ready++;
 return {research_ready:ready,uploaded_ready:(await candidates(ctx,c,'upload',day)).length,daily_remaining:Math.max(0,Math.min(30,c.config.target)-(allocation?.allocated||0)),other_campaign_today:!!allocation&&allocation.campaign_id!==c.id};
}
export async function startCampaignDiscovery(ctx,c,{trigger='manual',occurrenceDate=null}={}){
 if(c.status==='stopped')throw conflict('campaign_stopped','This campaign is stopped.');
 if(!c.config.filters.roles.length&&!c.config.filters.industries.length)throw invalid('Choose at least one role or industry.');
 let runId;
 await ctx.db.tx(async()=>{
 await ctx.db.run('UPDATE workspaces SET name=name WHERE id=?',[ctx.ws]);
 const running=await ctx.db.get("SELECT id FROM discovery_runs WHERE campaign_id=? AND status IN ('queued','running')",[c.id]);
 if(running){if(occurrenceDate)await ctx.db.run('UPDATE discovery_runs SET occurrence_date=coalesce(occurrence_date,?) WHERE id=?',[occurrenceDate,running.id]);runId=running.id;return;}
 const day=now().slice(0,10),research=c.config.source==='research';
 const days=research?await ctx.db.all('SELECT * FROM research_days WHERE workspace_id=? ORDER BY day',[ctx.ws]):[];
 const today=days.find(d=>d.day===day);
 if(today&&today.campaign_id!==c.id)throw conflict('research_campaign_limit','Research Leads is already in use by another campaign today. Continue in that campaign or try tomorrow (UTC).');
 const weekStart=new Date(day+'T00:00:00Z');weekStart.setUTCDate(weekStart.getUTCDate()-((weekStart.getUTCDay()+6)%7));
 if(research&&!today&&days.filter(d=>d.day>=weekStart.toISOString().slice(0,10)).length>=5)throw conflict('pilot_complete','You have used your five research days this week. Research is available again next week (UTC).');
 const target=Math.min(30,c.config.target),remaining=research?target-(today?.allocated||0):target;
 if(remaining<=0)throw conflict('daily_limit','This campaign has received its daily research target. More leads can be requested tomorrow (UTC).');
 const selected=[],list=await candidates(ctx,c,c.config.source,day),assessments=research?await assessCandidates(ctx,c,list):null;
 for(const cand of list){
 if(research&&assessments.get(cand.id).decision!=='qualified')continue;
 selected.push(cand);if(selected.length>=remaining)break;
 }
 if(!selected.length)throw conflict('no_new_contacts',research?'No new leads match your campaign yet. Check back later or import your own contacts.':'Upload new contacts for this campaign to continue.');
 const batch=((await ctx.db.get('SELECT max(batch) b FROM discovery_runs WHERE campaign_id=?',[c.id])).b||0)+1;
 const run={id:id(),campaign_id:c.id,batch,config_version:c.config_version,trigger,occurrence_date:occurrenceDate,status:'queued',progress:'{}',created_at:now()};
 await ctx.db.insert('discovery_runs',run);
 for(const cand of selected)await ctx.db.insert('campaign_contact_claims',{workspace_id:ctx.ws,campaign_id:c.id,contact_id:cand.id,run_id:run.id,source:c.config.source});
 if(research)await ctx.db.run(`INSERT INTO research_days(workspace_id,day,campaign_id,allocated) VALUES(?,?,?,?) ON CONFLICT(workspace_id,day) DO UPDATE SET allocated=research_days.allocated+excluded.allocated`,[ctx.ws,day,c.id,selected.length]);
 await ctx.jobs.enqueue(ctx.ws,'discovery',{run_id:run.id},{dedupe:'discovery:'+run.id});
 await ctx.db.audit(ctx.ws,c.id,'discovery.queued',research?'Research leads requested':'Imported contacts queued for review',{run_id:run.id,count:selected.length},ctx.user?.id);runId=run.id;
 });const run=await ctx.db.get('SELECT * FROM discovery_runs WHERE id=?',[runId]);return {...run,progress:JSON.parse(run.progress)};
}

// Reserve one weekly research batch atomically; preparation is still subject to every fit check.
export async function startWeeklyDiscovery(ctx, campaignId, at = Date.now()) {
 const c=await loadCampaign(ctx,campaignId);
 if(c.status==='stopped'||c.config.source!=='research') throw conflict('weekly_unavailable','Weekly planning requires an active or draft Research Leads campaign.');
 if(!c.config.filters.roles.length&&!c.config.filters.industries.length) throw invalid('Choose at least one role or industry.');
 const date=localView(at,'Asia/Kolkata').date, offset=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(weekdayOf(date)), monday=addDays(date,-offset);
 let result;
 await ctx.db.tx(async()=>{
  await ctx.db.run('UPDATE workspaces SET name=name WHERE id=?',[ctx.ws]);
  if(await ctx.db.get("SELECT id FROM discovery_runs WHERE campaign_id=? AND status IN ('queued','running')",[c.id]))throw conflict('discovery_running','Wait for the current discovery run to finish.');
  const all=await candidates(ctx,c,'research',date), assessments=await assessCandidates(ctx,c,all);
  const eligible=all.filter(x=>assessments.get(x.id).decision==='qualified').slice(0,150);
  if(!eligible.length)throw conflict('no_new_contacts','No new matching research contacts are available.');
  const localToday=localView(at,c.config.schedule.timezone).date;
  let cursor=0, assignedWeek=null, firstDate=null;
  const runId=id(),batch=Number((await ctx.db.get('SELECT max(batch) b FROM discovery_runs WHERE campaign_id=?',[c.id])).b||0)+1,createdAt=now();
  await ctx.db.insert('discovery_runs',{id:runId,campaign_id:c.id,batch,config_version:c.config_version,trigger:'weekly',occurrence_date:null,status:'queued',progress:'{}',created_at:createdAt});
  // Use this week if it has room, otherwise reserve the next week. Never allocate both weeks in one request.
  for(const week of [monday,addDays(monday,7)]){
   const plan=planWeeklySlots({monday:week,count:eligible.length,target:c.config.target,schedule:c.config.schedule});
   for(const day of plan.days.filter(d=>d.date>=localToday)){
    const existing=await ctx.db.get('SELECT * FROM research_days WHERE workspace_id=? AND day=?',[ctx.ws,day.date]);
    if(existing&&existing.campaign_id!==c.id)continue;
    const room=Math.max(0,Math.min(c.config.target,30)-Number(existing?.allocated||0));
    let n=0; while(n<room&&cursor<eligible.length){const lead=eligible[cursor++];
     await ctx.db.insert('campaign_contact_claims',{workspace_id:ctx.ws,campaign_id:c.id,contact_id:lead.id,run_id:runId,source:'research'});
     await ctx.db.insert('weekly_slots',{workspace_id:ctx.ws,campaign_id:c.id,contact_id:lead.id,run_id:runId,slot_date:day.date});n++;
    }
    if(n){firstDate ||= day.date;assignedWeek=week;await ctx.db.run(`INSERT INTO research_days(workspace_id,day,campaign_id,allocated) VALUES(?,?,?,?) ON CONFLICT(workspace_id,day) DO UPDATE SET allocated=research_days.allocated+excluded.allocated`,[ctx.ws,day.date,c.id,n]);}
   }
   if(cursor)break;
  }
  if(!cursor)throw conflict('weekly_full','No available slots remain this week or next week. Review your schedule or another campaign’s reservations.');
  await ctx.jobs.enqueue(ctx.ws,'discovery',{run_id:runId},{dedupe:'discovery:'+runId});
  await ctx.db.audit(ctx.ws,c.id,'weekly.queued','Weekly research reserved',{run_id:runId,count:cursor,unassigned:eligible.length-cursor},ctx.user?.id);
  result={run_id:runId,assigned:cursor,unassigned:eligible.length-cursor,week_start:assignedWeek,first_date:firstDate};
 });
 return {...result,run:await ctx.db.get('SELECT * FROM discovery_runs WHERE id=?',[result.run_id])};
}
