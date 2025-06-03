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


// ✅ Multi-token rotation setup (20 tokens)

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

  'DRiP6pNmn6kgYXZDJrPShGi4m8Rr5P6cHUWk5pYa4Jyo', // DRIP

  '7xKXyuC49ieGjRULaMUNRR1oDvnm5Bk8DZ2z1UWiUjR3', // SAMO

  'hntyVPpSVuqZZh1mxZ9oYrRCJ5Fgho77Wqz1ukJkT67', // HNT

  'JUPy1e1ebLmqcBgBPjYDCn8EdtT7GzHvRksvFQKbSLZ', // JUP

  'mb1eu7T8rceVw8Cd9PRspTnkqTaqnUMybAuvvA3BA1b', // MOBILE

  'LaMBogkxbgtNSZcUq7bYaUzmZcWak5nHxpiL7FeAr8M', // WENLAMBO

  'tnsr1DdXVDw6VdM8HZihfN7cxDUYfWJUzfjTRcAMPhkT', // TNSR

  '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT', // POPCAT

  'DUSTawucrTsGU8hcqRdHDCbuYhCPADMLM2VcCb8VnFnQ', // DUST

  'ReALUXZc1oBZTqMZXYaSniB6Kv9f2Ydj2QtRKujBYyG'  // REAL

];

let currentTokenIndex = 0;


async function getSolUsdPrice() {

  try {

    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');

    return res.data.solana.usd;

  } catch {

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

      value: Math.round(amountUSD * 100)

    }, {

      headers: {

        Authorization: `Bearer ${BLOCKONOMICS_API_KEY}`,

        'Content-Type': 'application/json'

      }

    });

    return { status: 'success', address: toAddress, orderId: res.data.order_id };

  } catch (err) {

    return { status: 'failed', address: toAddress, message: err.message };

  }

}


async function snipeOnce() {

  if (!isRunning) return;


  const solPrice = await getSolUsdPrice();

  if (!solPrice) return;


  const inputMint = 'So11111111111111111111111111111111111111112';

  const outputMint = outputMintOptions[currentTokenIndex % outputMintOptions.length];

  currentTokenIndex++;


  const inputAmountSol = 0.1;

  const inputAmountLamports = Math.round(inputAmountSol * LAMPORTS_PER_SOL);


  const quote = await getJupiterQuote(inputMint, outputMint, inputAmountLamports);

  if (!quote || !quote.routes?.length) return;


  const bestRoute = quote.routes[0];


  try {

    const swapRes = await axios.post('https://quote-api.jup.ag/v6/swap', {

      route: bestRoute,

      userPublicKey: PLATFORM_SOLANA_PUBLIC_KEY.toBase58(),

      wrapUnwrapSOL: true

    }, {

      headers: { Authorization: `Bearer ${JUPITER_API_KEY}` }

    });


    const tx = Transaction.from(Buffer.from(swapRes.data.swapTransaction, 'base64'));

    tx.sign(internalWalletKeypair);

    const txid = await connection.sendRawTransaction(tx.serialize());

    await connection.confirmTransaction(txid, 'confirmed');


    const valueUSD = (bestRoute.outAmount / (10 ** bestRoute.outToken.decimals)) * solPrice;

    const costUSD = inputAmountSol * solPrice;

    const net = valueUSD - costUSD;


    if (net > 0.2) {

      profitUSD += net;

      console.log(`🟢 PROFIT: $${net.toFixed(2)} | Total: $${profitUSD.toFixed(2)}`);

    } else {

      console.log(`⚠️ Low profit: $${net.toFixed(2)} — Skipped`);

    }

  } catch (err) {

    console.error('[SWAP ERROR]', err.message);

  }

}


// --- API ROUTES ---

app.post('/start', async (req, res) => {

  if (isRunning) return res.json({ message: "Already running." });

  isRunning = true;

  startTime = Date.now();

  intervalHandle = setInterval(snipeOnce, 30000);

  res.json({ message: "Sniping started." });

});


app.post('/stop', (req, res) => {

  isRunning = false;

  clearInterval(intervalHandle);

  res.json({ message: "Sniping stopped." });

});


app.get('/status', async (req, res) => {

  const solPrice = await getSolUsdPrice();

  res.json({

    running: isRunning,

    uptimeHours: ((Date.now() - startTime) / 3600000).toFixed(2),

    profitUSD: profitUSD.toFixed(2),

    solUsdPrice: solPrice

  });

});


app.post('/withdraw', async (req, res) => {

  if (profitUSD <= 0) return res.json({ status: 'failed', message: 'No profit yet' });


  const btc80 = 'bc1q3h4murmcasrgxresm5cmgchxl3zk66ukxzjn93';

  const btc20 = 'bc1q9k79mkx82h8e8awvda5slgw9sku0lyrf5mlaek';

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


// --- Launch Server ---

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(`✅ M & M backend live on port ${PORT}`);

});

