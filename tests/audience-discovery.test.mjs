import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkCandidate} from '../server/sourcing.mjs';
import {defaultConfig} from '../server/campaigns.mjs';
test('audience-only discovery retains email and suppression gates without requiring a funding event',()=>{
 const cfg=defaultConfig({});assert.deepEqual(cfg.signals,[]);cfg.filters.roles=['Founder'];cfg.filters.seniority=['Founder / Owner'];
 const lead={role:'Founder',seniority:'Founder / Owner',email:'test@example.com',email_status:'unverified',company:'Test',domain:'example.com'};
 let result=checkCandidate({},cfg,{},lead,[],'2026-11-05');
 assert.equal(result.decision,'review');assert.deepEqual(result.missing,['Email']);
 result=checkCandidate({},cfg,{}, {...lead,email_status:'valid'},[],'2026-11-05');assert.equal(result.decision,'qualified');
 result=checkCandidate({},cfg,{}, {...lead,email_status:'valid',suppressed:'unsubscribe'},[],'2026-11-05');assert.equal(result.decision,'excluded');
 cfg.signals=['Funding'];result=checkCandidate({},cfg,{},lead,[],'2026-11-05');assert.equal(result.decision,'excluded');
});
