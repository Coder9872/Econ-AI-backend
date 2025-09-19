const cron = require('node-cron');
const {format}=require('date-fns');
const  {toZonedTime}=require('date-fns-tz');
const {fetchAndStoreNews}=require('../services/newsService');
const {supabase}=require('../models/supabaseClient');
//daily scrape
async function reduceRelevanceScores() {
    console.log('Starting relevance score reduction process at', new Date().toISOString());
    // Reduce relevance_score by 1 for all articles with relevance_score > 0
    // fetch all articles with relevance > 0
    const { data: articles, error: fetchError } = await supabase
      .from('Articles')
      .select('id,relevance')
      .gt('relevance', 0);

    if (fetchError) throw fetchError;

    // update each article's relevance to 60% of its current value
    await Promise.all(
      (articles || []).map(({ id, relevance }) => {
        const newRelevance = Number(relevance) - 1;
        if (Number.isNaN(newRelevance)) return Promise.resolve();
        if (newRelevance < 10) {
          return supabase
            .from('Articles')
            .delete()
            .eq('id', id);
        }
        return supabase
          .from('Articles')
          .update({ relevance: newRelevance })
          .eq('id', id);
      })
    );
}
function scheduleRelevanceReduction() {
  // 12:00 AM America/Los_Angeles weekly (cron: minute hour * * *)
  cron.schedule('0 0 * * 7', () => {
    console.log('Triggering weekly relevance score reduction (12:00 AM) at', new Date().toISOString());
    reduceRelevanceScores().catch(err => console.error('Error during relevance score reduction:', err));
  }, { scheduled: true, timezone: 'America/Los_Angeles' });

  console.log('Scheduled weekly relevance score reduction at 12:00 AM America/Los_Angeles');
}

module.exports = { reduceRelevanceScores, scheduleRelevanceReduction };
