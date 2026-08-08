// Provide WebSocket polyfill for Supabase realtime in Node.js environments
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    globalThis.WebSocket = require('ws');
  } catch (e) {
    console.warn("ws package could not be loaded directly.");
  }
}

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');
const https = require('https');
const urlModule = require('url');
require('dotenv').config();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing Supabase credentials! Please set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// SOCKS5 Proxy Configuration (e.g. socks5://100.X.Y.Z:1080)
const SOCKS_PROXY = process.env.SOCKS_PROXY || process.env.socks_proxy || process.env.ALL_PROXY || process.env.all_proxy;
let proxyAgent = null;

async function initProxy() {
  if (SOCKS_PROXY) {
    try {
      if (SOCKS_PROXY.startsWith('http')) {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        proxyAgent = new HttpsProxyAgent(SOCKS_PROXY);
        console.log(`Using HTTP/HTTPS proxy for Jio TV EPG: ${SOCKS_PROXY}`);
      } else {
        const { SocksProxyAgent } = await import('socks-proxy-agent');
        proxyAgent = new SocksProxyAgent(SOCKS_PROXY);
        console.log(`Using SOCKS proxy for Jio TV EPG: ${SOCKS_PROXY}`);
      }
    } catch (e) {
      console.warn("WARNING: SOCKS_PROXY is defined but proxy agent failed to load.", e.message);
    }
  }
}

const nodeFetch = require('node-fetch');

// Custom fetch wrapper supporting SOCKS5 routing via standard https agent
async function fetchWithProxy(url, options = {}) {
  const fetchOptions = {
    ...options,
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      ...options.headers
    }
  };

  if (proxyAgent) {
    fetchOptions.agent = proxyAgent;
  }

  return nodeFetch(url, fetchOptions);
}

// Fetch channel list from oneportals backend
async function fetchChannels() {
  const backendUrl = process.env.JIOTV_BACKEND_URL || 'https://oneportals.com';
  const url = `${backendUrl}/channels`;
  console.log(`Fetching channels from: ${url}`);
  const res = await fetchWithProxy(url);
  if (!res.ok) throw new Error(`Failed to fetch channels from backend: ${res.status}`);
  const data = await res.json();
  return data.result || [];
}

// Fetch EPG from Jio CDN for a channel and offset
async function fetchEPGForChannel(channelId, offset) {
  const url = `https://jiotv.data.cdn.jio.com/apis/v1.3/getepg/get?offset=${offset}&channel_id=${channelId}`;
  try {
    const res = await fetchWithProxy(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      }
    });
    if (!res.ok) {
      if (res.status === 404) return []; // Non-catchup channel
      let errorBody = '';
      try {
        errorBody = await res.text();
      } catch (e) {}
      throw new Error(`HTTP ${res.status} - ${errorBody.substring(0, 200)}`);
    }
    const data = await res.json();
    return data.epg || [];
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error(`  [Jio EPG] Failed to fetch channel ${channelId} offset ${offset}: ${errorMsg}`);
    return [];
  }
}

async function runSyncWithRetry() {
  await initProxy();
  let success = false;
  let retryCount = 0;

  while (!success) {
    console.log("=========================================");
    console.log("  JioTV EPG Supabase Synchronization");
    console.log(`  Time: ${new Date().toISOString()}`);
    console.log(`  Attempt: ${retryCount + 1}`);
    console.log("=========================================");

    try {
      const channels = await fetchChannels();
      console.log(`Loaded ${channels.length} channels.`);

      if (channels.length === 0) {
        console.error("  [Sync Error] Loaded 0 channels. Aborting EPG sync.");
        return;
      }

      // Delete old EPG records (older than yesterday) to save database space
      const yesterdayStart = new Date();
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      yesterdayStart.setHours(0, 0, 0, 0);
      const pruneThreshold = yesterdayStart.toISOString();

      console.log(`Pruning old EPG records ending before ${pruneThreshold}...`);
      const { error: pruneError } = await supabase
        .from('jiotv_epg')
        .delete()
        .lt('till', pruneThreshold);

      if (pruneError) {
        console.error("  [Supabase Error] Failed to prune old EPG data:", pruneError.message);
      } else {
        console.log("  >> Successfully pruned old EPG records from Supabase!");
      }

      // Loop through offsets: 0 (today), 1 (tomorrow)
      const offsets = [0, 1];

      for (const offset of offsets) {
        console.log(`\nProcessing day offset: ${offset}...`);
        let allRecords = [];

        // Concurrency limit = 3 requests at a time
        const concurrencyLimit = 3;
        for (let i = 0; i < channels.length; i += concurrencyLimit) {
          const chunk = channels.slice(i, i + concurrencyLimit);
          const promises = chunk.map(async (ch) => {
            const epgItems = await fetchEPGForChannel(ch.channel_id, offset);
            return epgItems.map((item) => ({
              channel_id: ch.channel_id,
              showname: item.showname,
              description: item.description || '',
              episode_num: item.episode_num || 0,
              start: item.start ? new Date(item.start).toISOString() : null,
              till: item.end ? new Date(item.end).toISOString() : null,
              icon: item.icon ? `https://jiotv.data.cdn.jio.com/apis/v1.3/getepg/get?icon=${item.icon}` : null,
              genre: item.showGenre || '',
              srno: item.srno || 0
            })).filter(rec => rec.start && rec.till);
          });

          const results = await Promise.all(promises);
          results.forEach(records => allRecords.push(...records));

          // Sleep 150ms between batches to avoid rate limiting
          await new Promise(r => setTimeout(r, 150));
        }

        console.log(`Fetched ${allRecords.length} total EPG items for offset ${offset}. Upserting to Supabase...`);

        // Upsert in batches of 1000 to prevent payload overflow
        const batchSize = 1000;
        for (let i = 0; i < allRecords.length; i += batchSize) {
          const batch = allRecords.slice(i, i + batchSize);
          const { error } = await supabase
            .from('jiotv_epg')
            .upsert(batch, { onConflict: 'channel_id,start' });

          if (error) {
            console.error(`  [Supabase Upsert Error] Batch ${i} to ${i + batchSize}: ${error.message}`);
          } else {
            console.log(`    Successfully upserted batch (${i} to ${Math.min(i + batchSize, allRecords.length)})`);
          }
        }
        console.log(`  Completed day offset: ${offset}`);
      }

      console.log("\nEPG synchronization successfully completed!");
      success = true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("\n[Fatal Error during EPG Sync]:", errorMsg);
      retryCount++;
      console.log(`\nRetrying in 5 minutes... (Attempt ${retryCount})`);
      await new Promise(r => setTimeout(r, 5 * 60 * 1000));
    }
  }
}

runSyncWithRetry();
