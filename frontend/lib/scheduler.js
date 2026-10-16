// Minimal in-process cron for the Node server, replacing the Worker's cron
// triggers: the hourly crawl at :07 (wrangler "7 * * * *") and the weekly
// Telegram digest on Mondays 01:00 UTC ("0 1 * * 1").
const HOURLY_MINUTE = 7;
const WEEKLY = { day: 1, hour: 1, minute: 0 }; // getUTCDay(): 1 = Monday

export function startScheduler({ hourly, weekly, log = console } = {}) {
  let lastHourlyKey = '';
  let lastWeeklyKey = '';
  let running = false;

  // `now` is a parameter so tests can simulate any time
  function tick(now = new Date()) {
    const hourlyKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;
    if (now.getUTCMinutes() === HOURLY_MINUTE && lastHourlyKey !== hourlyKey) {
      lastHourlyKey = hourlyKey;
      if (running) log.warn('scheduler: previous crawl still running, skipping this hour');
      else {
        running = true;
        Promise.resolve()
          .then(hourly)
          .catch((err) => log.error('scheduler: hourly crawl failed:', err))
          .finally(() => { running = false; });
      }
    }

    const weeklyKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
    if (
      now.getUTCDay() === WEEKLY.day && now.getUTCHours() === WEEKLY.hour &&
      now.getUTCMinutes() === WEEKLY.minute && lastWeeklyKey !== weeklyKey
    ) {
      lastWeeklyKey = weeklyKey;
      Promise.resolve()
        .then(weekly)
        .catch((err) => log.error('scheduler: weekly digest failed:', err));
    }
  }

  const timer = setInterval(tick, 30_000);
  tick();
  return { tick, stop: () => clearInterval(timer) };
}
