const express = require('express');
const {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  Transaction,
} = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// ENV setup
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

function validateEnv(requiredVars) {
  const missing = requiredVars.filter(v => !process.env[v]);
  if (missing.length) {
    console.error("❌ Missing required ENV vars:", missing);
    throw new Error("Missing environment variables: " + missing.join(', '));
  }
}

validateEnv([
  'SOLANA_RPC_URL',
  'PLATFORM_SOLANA_ADDRESS',
  'SOLANA_PRIVATE_KEY_BASE58',
  'BLOCKONOMICS_API_KEY',
  'USER_BTC_ADDRESS',
  'RESERVE_BTC_ADDRESS'
]);

const PLATFORM_SOLANA_PUBLIC_KEY = new PublicKey(process.env.PLATFORM_SOLANA_ADDRESS);
const internalWalletKeypair = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY_BASE58));

let isRunning = false;
let profitUSD = 0;
let startTime = null;
let intervalHandle = null;

const outputMintOptions = [
  'EPjFWdd5AufqSSqeM2qN1xzybapT8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERUjBz2X4T5UoD7gwo8pWxSyh5MZgibY4M', // USDT
  'So11111111111111111111111111111111111111112'  // SOL
];

let currentTokenIndex = 0;

async function getSolUsdPrice() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    return res.data.solana.usd;
  } catch (err) {
    console.error('[CoinGecko] Price Error:', err.message);
    return 0;
  }
}

async function getJupiterQuote(inputMint, outputMint, amount) {
  try {
    const res = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: { inputMint, outputMint, amount, slippageBps: 100 },
      timeout: 20000
    });
    return res.data;
  } catch (err) {
    console.error('[JUPITER] Quote Error:', err.message);
    return null;
  }
}

async function sendBTC(toAddress, amountUSD) {
  try {
    const res = await axios.post('https://www.blockonomics.co/api/merchant_order', {
      addr: toAddress,
      value: Math.round(amountUSD * 100)
    }, {
      headers: {
        Authorization: `Bearer ${process.env.BLOCKONOMICS_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    return { status: 'success', address: toAddress, orderId: res.data.order_id };
  } catch (err) {
    console.error('[Blockonomics] Send BTC Error:', err.message);
    return { status: 'failed', address: toAddress, message: err.message };
  }
}

async function snipeOnce() {
  const solPrice = await getSolUsdPrice();
  if (!solPrice) return;

  const inputMint = 'So11111111111111111111111111111111111111112';
  const outputMint = outputMintOptions[currentTokenIndex % outputMintOptions.length];
  currentTokenIndex++;
  const inputAmountSol = 0.3;
  const inputAmountLamports = Math.round(inputAmountSol * LAMPORTS_PER_SOL);

  const quote = await getJupiterQuote(inputMint, outputMint, inputAmountLamports);
  if (!quote || !quote.routes?.length) return;

  const bestRoute = quote.routes[0];

  try {
    const swapRes = await axios.post('https://lite-api.jup.ag/swap/v1/swap', {
      route: bestRoute,
      userPublicKey: PLATFORM_SOLANA_PUBLIC_KEY.toBase58(),
      wrapUnwrapSOL: true
    });

    const tx = Transaction.from(Buffer.from(swapRes.data.swapTransaction, 'base64'));
    tx.sign(internalWalletKeypair);
    const txid = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(txid, 'confirmed');

    const valueUSD = (bestRoute.outAmount / (10 ** bestRoute.outToken.decimals)) * solPrice;
    const costUSD = inputAmountSol * solPrice;
    const net = valueUSD - costUSD;

    if (net > 0.4) {
      profitUSD += net;
      console.log(`Profit: $${net.toFixed(2)} | Total: $${profitUSD.toFixed(2)}`);
    }
  } catch (err) {
    console.error('[SWAP ERROR]', err.response ? err.response.data : err.message);
  }
}

// API Endpoints
app.get('/', (_, res) => {
  res.send('✅ M & M Sniper Bot API Ready');
});

app.post('/start', (_, res) => {
  if (isRunning) return res.json({ message: "Already running." });
  isRunning = true;
  startTime = Date.now();
  profitUSD = 0;
  intervalHandle = setInterval(snipeOnce, 30000);
  console.log('Sniping started.');
  res.json({ message: "Sniping started." });
});

app.post('/stop', (_, res) => {
  if (!isRunning) return res.json({ message: "Not running." });
  isRunning = false;
  clearInterval(intervalHandle);
  intervalHandle = null;
  console.log('Sniping stopped.');
  res.json({ message: "Sniping stopped." });
});

app.get('/status', async (_, res) => {
  const solPrice = await getSolUsdPrice();
  const uptimeMs = isRunning && startTime ? Date.now() - startTime : 0;
  const uptimeHours = (uptimeMs / 3600000).toFixed(2);
  const daily = isRunning && uptimeMs > 0 ? (profitUSD / (uptimeMs / 86400000)).toFixed(2) : '0.00';

  res.json({
    running: isRunning,
    uptimeHours,
    profitUSD: profitUSD.toFixed(2),
    solUsdPrice: solPrice,
    daily,
    weekly: (parseFloat(daily) * 7).toFixed(2),
    monthly: (parseFloat(daily) * 30).toFixed(2)
  });
});

app.post('/withdraw', async (_, res) => {
  if (profitUSD <= 0) return res.json({ status: 'failed', message: 'No profit yet to withdraw.' });

  const [btc80, btc20] = [process.env.USER_BTC_ADDRESS, process.env.RESERVE_BTC_ADDRESS];
  const [usd80, usd20] = [profitUSD * 0.8, profitUSD * 0.2];

  const r1 = await sendBTC(btc80, usd80);
  const r2 = await sendBTC(btc20, usd20);

  if (r1.status === 'success' && r2.status === 'success') {
    profitUSD = 0;
    res.json({ status: 'success', btcSent: [r1, r2] });
  } else {
    res.status(500).json({ status: 'failed', btcResults: [r1, r2] });
  }
});

// Export for Vercel
module.exports = app;
