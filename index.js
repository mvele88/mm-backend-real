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

const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// --- Environment Variables (Declaration only here) ---
// We will initialize them robustly later
let JUPITER_API_KEY;
let BLOCKONOMICS_API_KEY;
let PLATFORM_SOLANA_ADDRESS;
let PLATFORM_SOLANA_PUBLIC_KEY;
let SOLANA_PRIVATE_KEY_BASE58;
let internalWalletKeypair;

// --- Flag for successful environment variable loading ---
let envLoadedSuccessfully = false;

// Function to load and validate environment variables
function loadEnvVariables() {
  JUPITER_API_KEY = process.env.JUPITER_API_KEY;
  BLOCKONOMICS_API_KEY = process.env.BLOCKONOMICS_API_KEY;
  PLATFORM_SOLANA_ADDRESS = process.env.PLATFORM_SOLANA_ADDRESS;
  SOLANA_PRIVATE_KEY_BASE58 = process.env.SOLANA_PRIVATE_KEY_BASE58;

  // Validate critical environment variables
  if (!JUPITER_API_KEY) {
    console.error('ERROR: JUPITER_API_KEY is not set!');
    envLoadedSuccessfully = false;
    return;
  }
  if (!BLOCKONOMICS_API_KEY) {
    console.error('ERROR: BLOCKONOMICS_API_KEY is not set!');
    envLoadedSuccessfully = false;
    return;
  }
  if (!PLATFORM_SOLANA_ADDRESS) {
    console.error('ERROR: PLATFORM_SOLANA_ADDRESS is not set!');
    envLoadedSuccessfully = false;
    return;
  }
  if (!SOLANA_PRIVATE_KEY_BASE58) {
    console.error('ERROR: SOLANA_PRIVATE_KEY_BASE58 is not set!');
    envLoadedSuccessfully = false;
    return;
  }

  try {
    PLATFORM_SOLANA_PUBLIC_KEY = new PublicKey(PLATFORM_SOLANA_ADDRESS);
  } catch (e) {
    console.error('ERROR: Invalid PLATFORM_SOLANA_ADDRESS provided!', e.message);
    envLoadedSuccessfully = false;
    return;
  }

  try {
    internalWalletKeypair = Keypair.fromSecretKey(bs58.decode(SOLANA_PRIVATE_KEY_BASE58));
  } catch (e) {
    console.error('ERROR: Invalid SOLANA_PRIVATE_KEY_BASE58 provided!', e.message);
    envLoadedSuccessfully = false;
    return;
  }

  envLoadedSuccessfully = true;
  console.log('All essential environment variables loaded and validated.');
}

// Initial call to load variables on app start
loadEnvVariables();

let isRunning = false;
let profitUSD = 0;
let startTime = null;
let intervalHandle = null;

const outputMintOptions = [
  'EPjFWdd5AufqSSqeM2qN1xzybapT8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERUjBz2X4T5UoD7gwo8pWxSyh5MZgibY4M', // USDT
  'So11111111111111111111111111111111111111112', // SOL
  '5ZLzAfNjJGSEJR3vYrbwguCuqJe5GjgsrBfqM3Ajmv5f', // BONK
  '2Z6wKkkEMXH5S8xeu6vZswq2UScHt6uwKfFQ1iQ38zNt', // WIF
  'JitoUjbTMWXKs6jPQDQZREjxxU5F7r1r9Yg1xWj1bJp', // JTO
  'PYTHnXuHKPVvPXwTLrp5n2HiR61eYv4D1iQ1CSLeDRk', // PYTH
  'SHDWzUHX3Uxx2nM4vBy5oPXBMi5YTDYzYwD2M5YcFqw', // SHDW
  'wen2mbc5kbM9rCgEZLDVaExUeHvwKtxGLBoTExGktTf', // WEN
  'DoGo1bmxXZcNtzSZqw31nPMMLrm2ALU8JeDd3Xg2iNTZ', // DOG
  'DRiP6pNmn6kgYXZDJrPShGi4m8Rr5P6cHUWk5pYa4Jyo',
  '7xKXyuC49ieGjRULaMUNRR1oDvnm5Bk8DZ2z1UWiUjR3',
  'hntyVPpSVuqZZh1mxZ9oYrRCJ5Fgho77Wqz1ukJkT67',
  'JUPy1e1ebLmqcBgBPjYDCn8EdtT7GzHvRksvFQKbSLZ',
  'mb1eu7T8rceVw8Cd9PRspTnkqTaqnUMybAuvvA3BA1b',
  'LaMBogkxbgtNSZcUq7bYaUzmZcWak5nHxpiL7FeAr8M',
  'tnsr1DdXVDw6VdM8HZihfN7cxDUYfWJUzfjTRcAMPhkT',
  '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT',
  'DUSTawucrTsGU8hcqRdHDCbuYhCPADMLM2VcCb8VnFnQ',
  'ReALUXZc1oBZTqMZXYaSniB6Kv9f2Ydj2QtRKujBYyG'
];

let currentTokenIndex = 0;

// --- Middleware to check if environment variables are loaded ---
app.use((req, res, next) => {
  if (!envLoadedSuccessfully) {
    console.error(`Request to ${req.path} denied: Environment variables not loaded correctly.`);
    return res.status(500).json({
      status: 'error',
      message: 'Server configuration error. Essential environment variables or keys are invalid. Please check Vercel deployment logs for details.',
      details: 'Ensure JUPITER_API_KEY, BLOCKONOMICS_API_KEY, PLATFORM_SOLANA_ADDRESS, and SOLANA_PRIVATE_KEY_BASE58 are correctly set in Vercel environment variables.'
    });
  }
  next();
});

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
      headers: { Authorization: `Bearer ${JUPITER_API_KEY}` },
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
      value: Math.round(amountUSD * 100) // Blockonomics expects value in cents
    }, {
      headers: {
        Authorization: `Bearer ${BLOCKONOMICS_API_KEY}`,
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
  if (!isRunning) {
    console.log('Sniping is not running. Skipping snipeOnce execution.');
    return;
  }
  const solPrice = await getSolUsdPrice();
  if (!solPrice) {
    console.warn('Could not get SOL price. Skipping snipeOnce execution.');
    return;
  }

  const inputMint = 'So11111111111111111111111111111111111111112'; // SOL mint address
  const outputMint = outputMintOptions[currentTokenIndex % outputMintOptions.length];
  currentTokenIndex++;
  const inputAmountSol = 0.3; // Amount of SOL to swap
  const inputAmountLamports = Math.round(inputAmountSol * LAMPORTS_PER_SOL);
  console.log(`Getting Jupiter quote for ${inputAmountSol} SOL to ${outputMint}`);
  const quote = await getJupiterQuote(inputMint, outputMint, inputAmountLamports);
  if (!quote || !quote.routes?.length) {
    console.warn('No valid quote found. Skipping swap.');
    return;
  }

  const bestRoute = quote.routes[0];
  console.log(`Attempting swap for ${bestRoute.outAmount / (10 ** bestRoute.outToken.decimals)} ${bestRoute.outToken.symbol}`);

  try {
    const swapRes = await axios.post('https://quote-api.jup.ag/v6/swap', {
      route: bestRoute,
      userPublicKey: PLATFORM_SOLANA_PUBLIC_KEY.toBase58(),
      wrapUnwrapSOL: true // Automatically wrap/unwrap SOL if needed
    }, {
      headers: { Authorization: `Bearer ${JUPITER_API_KEY}` }
    });

    const tx = Transaction.from(Buffer.from(swapRes.data.swapTransaction, 'base64'));
    tx.sign(internalWalletKeypair); // Sign with the internal wallet
    const txid = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(txid, 'confirmed');
    console.log(`Swap successful! Transaction ID: ${txid}`);

    // Calculate profit based on output token's USD value
    const valueUSD = (bestRoute.outAmount / (10 ** bestRoute.outToken.decimals)) * solPrice;
    const costUSD = inputAmountSol * solPrice;
    const net = valueUSD - costUSD;

    if (net > 0.4) {
      profitUSD += net;
      const tokenName = bestRoute.outToken?.symbol || bestRoute.outToken?.address?.slice(0, 6) || 'Token';
      console.log(`Swapped to ${tokenName}: +$${net.toFixed(2)}. Total profit: $${profitUSD.toFixed(2)}`);
    } else {
      console.log(`⚠️ Low profit: $${net.toFixed(2)} — Skipped from profit accumulation.`);
    }
  } catch (err) {
    console.error('[SWAP ERROR]', err.response ? err.response.data : err.message);
  }
}

app.get('/', (req, res) => {
  res.send('Welcome to the M & M Backend API! Try `/status` for info, or `/start` to begin operations.');
});

app.post('/start', async (req, res) => {
  if (isRunning) return res.json({ message: "Already running." });
  isRunning = true;
  startTime = Date.now();
  profitUSD = 0;
  intervalHandle = setInterval(snipeOnce, 30000);
  console.log('Sniping started.');
  res.json({ message: "Sniping started." });
});

app.post('/stop', (req, res) => {
  if (!isRunning) return res.json({ message: "Not running." });
  isRunning = false;
  clearInterval(intervalHandle);
  intervalHandle = null;
  console.log('Sniping stopped.');
  res.json({ message: "Sniping stopped." });
});

app.get('/status', async (req, res) => {
  const solPrice = await getSolUsdPrice();
  const uptimeMs = isRunning && startTime ? Date.now() - startTime : 0;
  const uptimeHours = (uptimeMs / 3600000).toFixed(2);
  const daily = isRunning && uptimeMs > 0 ? (profitUSD / (uptimeMs / 86400000)).toFixed(2) : '0.00';
  const weekly = (parseFloat(daily) * 7).toFixed(2);
  const monthly = (parseFloat(daily) * 30).toFixed(2);

  res.json({
    running: isRunning,
    uptimeHours: uptimeHours,
    profitUSD: profitUSD.toFixed(2),
    solUsdPrice: solPrice,
    daily: daily,
    weekly: weekly,
    monthly: monthly
  });
});

app.post('/withdraw', async (req, res) => {
  if (profitUSD <= 0) return res.json({ status: 'failed', message: 'No profit yet to withdraw.' });

  const btc80 = 'bc1q3h4murmcasrgxresm5cmgchxl3zk66ukxzjn93';
  const btc20 = 'bc1q9k79mkx82h8e8awvda5slgw9sku0lyrf5mlaek';
  const [usd80, usd20] = [profitUSD * 0.8, profitUSD * 0.2];

  console.log(`Attempting to withdraw $${profitUSD.toFixed(2)}: $${usd80.toFixed(2)} to ${btc80} and $${usd20.toFixed(2)} to ${btc20}`);

  const r1 = await sendBTC(btc80, usd80);
  const r2 = await sendBTC(btc20, usd20);

  if (r1.status === 'success' && r2.status === 'success') {
    console.log('Withdrawal successful. Resetting profit.');
    profitUSD = 0;
    res.json({ status: 'success', message: 'Profit withdrawn.', btcSent: [r1, r2] });
  } else {
    console.error('Withdrawal failed. BTC results:', [r1, r2]);
    res.status(500).json({ status: 'failed', message: 'Withdrawal failed. Check logs for details.', btcResults: [r1, r2] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ M & M backend live on port ${PORT}`);
  console.log('Remember to set environment variables for production!');
});

// Export the app for Vercel serverless function
module.exports = app;