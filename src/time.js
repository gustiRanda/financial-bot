const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("dayjs/plugin/timezone"));
module.exports = { now: () => dayjs().tz("Asia/Jakarta") };