import {slotDate} from './domain.js';
// Client reporting follows the booking day; dashboard reporting remains available for corrections.
export const clientReportsAllowed = config => config.clientReportEnabled === true;
export const lastReportMinutes = config => Math.max(config.dashboardReportMinutes, clientReportsAllowed(config) ? config.clientReportMinutes : 0);
export const notificationReportMinutes = config => clientReportsAllowed(config) ? config.clientReportMinutes : config.dashboardReportMinutes;

export function clientReportDeadline(day,booking,rule){
  return slotDate(day,Math.max(rule.bathEnd,booking.start+booking.duration));
}
