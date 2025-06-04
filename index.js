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

// Ensure these environment variables are set in Vercel project settings!
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;
const BLOCKONOMICS_API_KEY = process.env.BLOCKONOMICS_API_KEY;
const PLATFORM_SOLANA_ADDRESS = process.env.PLATFORM_SOLANA_ADDRESS;
const PLATFORM_SOLANA_PUBLIC_KEY = new PublicKey(PLATFORM_SOLANA_ADDRESS);
const SOLANA_PRIVATE_KEY_BASE58 = process.env.SOLANA_PRIVATE_KEY_BASE58;
const internalWalletKeypair = Keypair.fromSecretKey(bs58.decode(SOLANA_PRIVATE_KEY_BASE58));

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

async function getSolUsdPrice() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    return res.data.solana.usd;
  } catch (err) {
    console.error('[CoinGecko] Price Error:', err.message); // Added console.error
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
    console.error('[Blockonomics] Send BTC Error:', err.message); // Added console.error
    return { status: 'failed', address: toAddress, message: err.message };
  }
}

async function snipeOnce() {
  if (!isRunning) {
    console.log('Sniping is not running. Skipping snipeOnce execution.'); // Added log
    return;
  }
  const solPrice = await getSolUsdPrice();
  if (!solPrice) {
    console.warn('Could not get SOL price. Skipping snipeOnce execution.'); // Added warn
    return;
  }

  const inputMint = 'So11111111111111111111111111111111111111112'; // SOL mint address
  const outputMint = outputMintOptions[currentTokenIndex % outputMintOptions.length];
  currentTokenIndex++;
  const inputAmountSol = 0.3; // Amount of SOL to swap
  const inputAmountLamports = Math.round(inputAmountSol * LAMPORTS_PER_SOL);
  console.log(`Getting Jupiter quote for ${inputAmountSol} SOL to ${outputMint}`); // Added log
  const quote = await getJupiterQuote(inputMint, outputMint, inputAmountLamports);
  if (!quote || !quote.routes?.length) {
    console.warn('No valid quote found. Skipping swap.'); // Added warn
    return;
  }

  const bestRoute = quote.routes[0];
  console.log(`Attempting swap for ${bestRoute.outAmount / (10 ** bestRoute.outToken.decimals)} ${bestRoute.outToken.symbol}`); // Added log

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
    console.log(`Swap successful! Transaction ID: ${txid}`); // Added log

    // Calculate profit based on output token's USD value
    // NOTE: This calculation assumes solPrice can be used to value the output token.
    // For tokens other than SOL, you'd ideally need their individual USD prices.
    // For simplicity, we'll proceed with the existing logic for now.
    const valueUSD = (bestRoute.outAmount / (10 ** bestRoute.outToken.decimals)) * solPrice; // This is a rough estimate if output isn't SOL
    const costUSD = inputAmountSol * solPrice;
    const net = valueUSD - costUSD;

    if (net > 0.4) { // Only count profit if it exceeds a threshold
      profitUSD += net;
      const tokenName = bestRoute.outToken?.symbol || bestRoute.outToken?.address?.slice(0, 6) || 'Token';
      console.log(`Swapped to ${tokenName}: +$${net.toFixed(2)}. Total profit: $${profitUSD.toFixed(2)}`); // Added log
    } else {
      console.log(`⚠️ Low profit: $${net.toFixed(2)} — Skipped from profit accumulation.`); // Added log
    }
  } catch (err) {
    console.error('[SWAP ERROR]', err.response ? err.response.data : err.message); // Improved error logging
  }
}

// *** NEW: Root Path Route ***
app.get('/', (req, res) => {
  res.send('Welcome to the M & M Backend API! Try `/status` for info, or `/start` to begin operations.');
});

app.post('/start', async (req, res) => {
  if (isRunning) return res.json({ message: "Already running." });
  isRunning = true;
  startTime = Date.now();
  profitUSD = 0; // Reset profit on start
  intervalHandle = setInterval(snipeOnce, 30000); // Run every 30 seconds
  console.log('Sniping started.'); // Added log
  res.json({ message: "Sniping started." });
});

app.post('/stop', (req, res) => {
  if (!isRunning) return res.json({ message: "Not running." }); // Added check
  isRunning = false;
  clearInterval(intervalHandle);
  intervalHandle = null; // Clear handle
  console.log('Sniping stopped.'); // Added log
  res.json({ message: "Sniping stopped." });
});

app.get('/status', async (req, res) => {
  const solPrice = await getSolUsdPrice();
  const uptimeMs = isRunning && startTime ? Date.now() - startTime : 0;
  const uptimeHours = (uptimeMs / 3600000).toFixed(2);
  // Calculate daily, weekly, monthly based on the average rate since start, if running
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
  if (profitUSD <= 0) return res.json({ status: 'failed', message: 'No profit yet to withdraw.' }); // Updated message

  const btc80 = 'bc1q3h4murmcasrgxresm5cmgchxl3zk66ukxzjn93';
  const btc20 = 'bc1q9k79mkx82h8e8awvda5slgw9sku0lyrf5mlaek';
  const [usd80, usd20] = [profitUSD * 0.8, profitUSD * 0.2];

  console.log(`Attempting to withdraw $${profitUSD.toFixed(2)}: $${usd80.toFixed(2)} to ${btc80} and $${usd20.toFixed(2)} to ${btc20}`); // Added log

  const r1 = await sendBTC(btc80, usd80);
  const r2 = await sendBTC(btc20, usd20);

  if (r1.status === 'success' && r2.status === 'success') {
    console.log('Withdrawal successful. Resetting profit.'); // Added log
    profitUSD = 0; // Reset profit after successful withdrawal
    res.json({ status: 'success', message: 'Profit withdrawn.', btcSent: [r1, r2] });
  } else {
    console.error('Withdrawal failed. BTC results:', [r1, r2]); // Added error log
    res.status(500).json({ status: 'failed', message: 'Withdrawal failed. Check logs for details.', btcResults: [r1, r2] });
  }
});

// For Vercel serverless functions, the app doesn't 'listen' on a port directly.
// Instead, Vercel wraps the app. However, keeping this for local testing purposes.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ M & M backend live on port ${PORT}`);
  console.log('Remember to set environment variables for production!');
});

// Export the app for Vercel serverless function (e.g., if this file is api/index.js)
module.exports = app;