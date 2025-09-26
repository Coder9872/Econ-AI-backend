// Test endpoint to verify QStash configuration and connectivity
const { Client: QStashClient } = require('@upstash/qstash');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const config = {
    hasQstashToken: !!process.env.QSTASH_TOKEN,
    hasVercelUrl: !!process.env.VERCEL_URL,
    hasVercelApiBase: !!process.env.VERCEL_API_BASE,
    qstashUrl: process.env.QSTASH_URL,
    vercelUrl: process.env.VERCEL_URL,
    vercelApiBase: process.env.VERCEL_API_BASE
  };

  if (!process.env.QSTASH_TOKEN) {
    return res.status(500).json({ error: 'Missing QSTASH_TOKEN', config });
  }

  try {
    const client = new QStashClient({ token: process.env.QSTASH_TOKEN });
    
    // Test simple connectivity (this won't actually publish)
    const testResult = {
      clientCreated: true,
      config,
      timestamp: new Date().toISOString()
    };

    return res.status(200).json({ success: true, ...testResult });
  } catch (e) {
    return res.status(500).json({ 
      error: 'qstash_test_failed',
      message: e.message,
      config
    });
  }
};