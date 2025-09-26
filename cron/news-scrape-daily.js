const cron = require('node-cron');
const {format}=require('date-fns');
const  {toZonedTime}=require('date-fns-tz');
const { fetchAndStoreNews } = require('../services/news-scrape');

//daily scrape
async function runDailyScrape() {
  try {
    const laNow = toZonedTime(new Date(), 'America/Los_Angeles');
    // Previous calendar day in LA timezone
    const prevDay = new Date(laNow);
    prevDay.setDate(prevDay.getDate() - 1);
    const prevDayStr = format(prevDay, 'yyyy-MM-dd');
    const from = prevDayStr;
    const to = prevDayStr; // Scrape only the previous full day

    console.log('Starting daily news scrape for full previous day', { from, to });
  await fetchAndStoreNews(from, to, { mode: 'cron' });
    console.log('Completed daily news scrape at', new Date().toISOString());
  } catch (err) {
    console.error('Daily scrape failed:', err?.message || err);
  }
}

function scheduleDailyScrape() {
  // 12:01 PM America/Los_Angeles daily (cron: minute hour * * *)
  cron.schedule('1 12 * * *', () => {
    console.log('Triggering daily news scrape (12:01 PM) at', new Date().toISOString());
    runDailyScrape().catch(err => console.error('Error during daily news scrape:', err));
  }, { scheduled: true, timezone: 'America/Los_Angeles' });

  console.log('Scheduled daily news scrape at 12:01 PM America/Los_Angeles (scrapes previous full day)');
}

module.exports = { runDailyScrape, scheduleDailyScrape };