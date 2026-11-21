// Pure weekly planning. This module does not reserve contacts or send email.
import { addDays, weekdayOf, zonedToUtc } from './lib.mjs';
import { scheduleErrors, scheduleTime } from './campaigns.mjs';

export function planWeeklySlots({ monday, count, target = 30, schedule, notBefore = monday }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monday || '') || !Number.isFinite(Date.parse(monday)) || new Date(monday).toISOString().slice(0, 10) !== monday || weekdayOf(monday) !== 'Mon') throw new Error('Choose a valid Monday date.');
  if (!Number.isInteger(count) || count < 0 || count > 150) throw new Error('A weekly batch must contain between 0 and 150 contacts.');
  if (!Number.isInteger(target) || target < 1 || target > 30) throw new Error('The daily target must be between 1 and 30.');
  const errors = scheduleErrors(schedule);
  if (errors.length) throw new Error(errors.join(' '));
  const availableAt = zonedToUtc(monday, '00:00', 'Asia/Kolkata');
  const days = [];
  for (let n = 0; n < 7 && days.length < 5; n++) {
    const date = addDays(monday, n), weekday = weekdayOf(date);
    if (!schedule.days.includes(weekday) || date < notBefore) continue;
    const dueAt = zonedToUtc(date, scheduleTime(schedule, weekday), schedule.timezone);
    if (Date.parse(dueAt) < Date.parse(availableAt)) continue;
    days.push({ date, weekday, due_at: dueAt, capacity: target, count: 0 });
  }
  let remaining = count;
  for (const day of days) { day.count = Math.min(target, remaining); remaining -= day.count; }
  return { available_at: availableAt, timezone: schedule.timezone, days, assigned: count - remaining, unassigned: remaining };
}
