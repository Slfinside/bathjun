// Report acceptance and stamp deadlines must follow the same active channels.
export const clientReportsAllowed = config => config.clientReportEnabled === true;
export const lastReportMinutes = config => Math.max(config.dashboardReportMinutes, clientReportsAllowed(config) ? config.clientReportMinutes : 0);
export const notificationReportMinutes = config => clientReportsAllowed(config) ? config.clientReportMinutes : config.dashboardReportMinutes;
