import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWeeklySlots } from '../server/weekly-plan.mjs';

const schedule = { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], time: '09:00', times: { Tue: '15:00' }, timezone: 'America/New_York' };
test('a Monday IST batch assigns up to 30 per selected day and honors local times', () => {
 const p = planWeeklySlots({monday:'2026-11-23',count:150,schedule});
 assert.equal(p.available_at,'2026-11-22T18:30:00.000Z');
 assert.deepEqual(p.days.map(d=>d.count),[30,30,30,30,30]);
 assert.equal(p.days[1].due_at,'2026-11-24T20:00:00.000Z');
 assert.equal(p.unassigned,0);
});
test('limited sending days do not overbook or silently spill into the next week', () => {
 const p=planWeeklySlots({monday:'2026-11-23',count:150,schedule:{...schedule,days:['Mon','Wed']}});
 assert.equal(p.assigned,60);assert.equal(p.unassigned,90);
 assert.throws(()=>planWeeklySlots({monday:'2026-11-24',count:1,schedule}));
 assert.throws(()=>planWeeklySlots({monday:'2026-11-23',count:151,schedule}));
});
