const express = require('express');

const {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  Transaction,
} = require('@solana/web3.js');
const {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID
} = require('@solana/spl-token');

const axios = require('axios');
const bs58 = require('bs58');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

const SOLANA_RPC_URL = 'https://fittest-patient-pond.solana-mainnet.quiknode.pro/de9d37470b2873fedf650c074df9c9aa8519f5d9/';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

const BLOCKONOMICS_API_KEY = process.env.BLOCKONOMICS_API_KEY;
const PLATFORM_SOLANA_ADDRESS = process.env.PLATFORM_SOLANA_ADDRESS;
const PLATFORM_SOLANA_PUBLIC_KEY = new PublicKey(PLATFORM_SOLANA_ADDRESS);
const SOLANA_PRIVATE_KEY_BASE58 = process.env.SOLANA_PRIVATE_KEY_BASE58;
const internalWalletKeypair = Keypair.fromSecretKey(bs58.decode(SOLANA_PRIVATE_KEY_BASE58));

// ✅ New Global Variable for Reinvestment Threshold
const SOL_REINVESTMENT_THRESHOLD_SOL = parseFloat(process.env.SOL_REINVESTMENT_THRESHOLD_SOL || '0.5'); // Default to 0.5 if not set

// ✅ New Global Variable for Automatic Payout Amount
const AUTO_PAYOUT_USD_AMOUNT = parseFloat(process.env.AUTO_PAYOUT_USD_AMOUNT || '0'); // Default to $0 if not set

// ✅ New Global Variable for BTC Withdrawal Fee Buffer
const BTC_WITHDRAWAL_FEE_BUFFER_USD = parseFloat(process.env.BTC_WITHDRAWAL_FEE_BUFFER_USD || '20.0'); // Now set to $20.0 based on your decision

let isRunning = false;
let profitUSD = 0;
let startTime = null;
let intervalHandle = null;
let reinvestmentCheckInterval = null;

const outputMintOptions = [
  'EPjFWdd5AufqSSqeM2qN1xzybapT8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERUjBz2X4T5UoD7gwo8pWxSyh5MZgibY4M', // USDT
  'So11111111111111111111111111111111111111112', // SOL (as an output option)
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
  'DUSTawucrTsGU8hcqRdHDCbuYhCFADMLM2VcCb8VnFnC', // DUST
  'ReALUXZc1oBZTqMZXYaSniB6Kv9f2Ydj2QtRKujBYyG'  // REAL
];
let currentTokenIndex = 0;

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapT8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERUjBz2X4T5UoD7gwo8pWxSyh5MZgibY4M';
const STABLECOIN_MINTS = [USDC_MINT, USDT_MINT];


// --- Helper Functions ---

async function getSolUsdPrice() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    return res.data.solana.usd;
  } catch (err) {
    console.error('[COINGECKO] Error fetching SOL price:', err.message);
    return 0;
  }
}

async function getJupiterQuote(inputMint, outputMint, inputAmount) {
  try {
    const res = await axios.get(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${inputAmount}&slippageBps=50`); // 0.5% slippage
    return res.data;
  } catch (err) {
    console.error('[JUPITER] Error getting quote:', err.message);
    return null;
  }
}

async function sendBTC(btcAddress, amountUSD) {
  if (amountUSD <= 0) {
      console.log(`Skipping BTC send to ${btcAddress}: amount is zero or negative.`);
      return { status: 'skipped', message: 'Amount too small or zero for BTC withdrawal.' };
  }
  try {
    const response = await axios.post(`https://www.blockonomics.co/api/merchant_order`, {
      order_id: `withdraw-${Date.now()}`,
      value: Math.round(amountUSD * 100), // Blockonomics expects value in cents
      currency: 'USD',
      address: btcAddress,
      callback: `https://yourdomain.com/blockonomics-callback?api_key=${BLOCKONOMICS_API_KEY}` // Replace with your actual domain if you set up a callback
    }, {
      headers: {
        'Authorization': 'Bearer ' + BLOCKONOMICS_API_KEY
      }
    });

    if (response.data && response.data.status === 'OK') {
      console.log(`Successfully initiated BTC withdrawal of $${amountUSD.toFixed(2)} to ${btcAddress}.`);
      return { status: 'success', message: 'BTC withdrawal initiated.', txid: response.data.txid };
    } else {
      console.error(`Blockonomics BTC withdrawal failed:`, response.data);
      return { status: 'failed', message: response.data.message || 'Blockonomics error.' };
    }
  } catch (err) {
    console.error(`Error sending BTC to ${btcAddress}:`, err.message);
    return { status: 'failed', message: err.message };
  }
}

// Get all token balances for the wallet
async function getWalletTokenBalances(ownerPublicKey) {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        ownerPublicKey,
        { programId: TOKEN_PROGRAM_ID }
    );

    const balances = {};
    for (const account of tokenAccounts.value) {
        const mintAddress = account.account.data.parsed.info.mint;
        const amount = account.account.data.parsed.info.tokenAmount.uiAmount;
        const decimals = account.account.data.parsed.info.tokenAmount.decimals;
        balances[mintAddress] = { amount, decimals, tokenAccount: account.pubkey.toBase58() };
    }
    return balances;
}

// Get Token USD Price (more generic than just SOL/USDC)
async function getTokenUsdPrice(mintAddress) {
  try {
    const res = await axios.get(`https://price.jup.ag/v4/price?id=${mintAddress}`);
    if (res.data && res.data.data && res.data.data[mintAddress]) {
      return res.data.data[mintAddress].price;
    }
    return 0;
  } catch (err) {
    console.error(`[JUPITER PRICE] Error fetching price for ${mintAddress}:`, err.message);
    return 0;
  }
}

// buySolWithStablecoins now accepts any token mint as input
async function buySolWithStablecoins(amountUSD, inputStablecoinMint) {
    if (amountUSD <= 0) {
        console.log('Skipping SOL reinvestment: amount is zero or negative.');
        return { status: 'skipped', message: 'Amount too small or zero for SOL reinvestment.' };
    }

    const walletBalances = await getWalletTokenBalances(internalWalletKeypair.publicKey);
    const stablecoinInfo = walletBalances[inputStablecoinMint];

    if (!stablecoinInfo || stablecoinInfo.amount * await getTokenUsdPrice(inputStablecoinMint) < amountUSD) {
        console.warn(`[SOL REINVESTMENT] Insufficient ${inputStablecoinMint === USDC_MINT ? 'USDC' : 'USDT'} balance in wallet for $${amountUSD.toFixed(2)} reinvestment.`);
        return { status: 'failed', message: `Insufficient ${inputStablecoinMint === USDC_MINT ? 'USDC' : 'USDT'} for reinvestment.` };
    }

    const inputMint = inputStablecoinMint;
    console.log(`Attempting to buy ${amountUSD.toFixed(2)} USD worth of SOL with ${inputMint === USDC_MINT ? 'USDC' : 'USDT'}.`);

    let inputAmountTokens = Math.round((amountUSD / (await getTokenUsdPrice(inputMint))) * (10**stablecoinInfo.decimals));

    // Ensure we don't try to swap more than we have
    if (inputAmountTokens > stablecoinInfo.amount * (10**stablecoinInfo.decimals)) {
        inputAmountTokens = stablecoinInfo.amount * (10**stablecoinInfo.decimals);
        console.warn(`Adjusted reinvestment amount to available ${inputMint === USDC_MINT ? 'USDC' : 'USDT'}: ${inputAmountTokens / (10**stablecoinInfo.decimals)}`);
    }

    const quote = await getJupiterQuote(inputMint, 'So11111111111111111111111111111111111111112', inputAmountTokens);

    if (!quote || !quote.routes?.length) {
        console.error('[SOL REINVESTMENT] No valid Jupiter quote found for stablecoin to SOL.');
        return { status: 'failed', message: 'No quote for SOL reinvestment.' };
    }

    const bestRoute = quote.routes[0];

    try {
        const swapRes = await axios.post('https://quote-api.jup.ag/v6/swap', {
            route: bestRoute,
            userPublicKey: internalWalletKeypair.publicKey.toBase58(),
            wrapUnwrapSOL: true
        });

        const tx = Transaction.from(Buffer.from(swapRes.data.swapTransaction, 'base64'));
        tx.sign(internalWalletKeypair);
        const txid = await connection.sendRawTransaction(tx.serialize());
        await connection.confirmTransaction(txid, 'confirmed');

        const solReceived = bestRoute.outAmount / LAMPORTS_PER_SOL;
        console.log(`✅ REINVESTMENT: Bought ${solReceived.toFixed(5)} SOL for $${amountUSD.toFixed(2)} USD (from ${inputMint === USDC_MINT ? 'USDC' : 'USDT'}).`);
        return { status: 'success', solReceived: solReceived, txid: txid, amountUSD: amountUSD };

    } catch (err) {
        console.error('[SOL REINVESTMENT] Swap execution error:', err.message);
        return { status: 'failed', message: err.message, amountUSD: amountUSD };
    }
}


// --- Main Trading Loop (snipeOnce) ---

async function snipeOnce() {
  if (!isRunning) return;

  const currentOutputMint = outputMintOptions[currentTokenIndex];
  const outputMintPublicKey = new PublicKey(currentOutputMint);

  console.log(`--- Running snipeOnce at ${new Date().toLocaleTimeString()} ---`);
  console.log(`Current output token: ${currentOutputMint}`);

  try {
    const solPrice = await getSolUsdPrice();
    if (!solPrice) {
      console.log("Could not get SOL price. Skipping trade.");
      return;
    }

    const solAmount = 0.01; // Example: trade with 0.01 SOL
    const inputAmountLamports = solAmount * LAMPORTS_PER_SOL;

    const quote = await getJupiterQuote('So11111111111111111111111111111111111111112', currentOutputMint, inputAmountLamports);

    if (!quote || !quote.routes?.length) {
      console.log('No valid Jupiter quote found. Skipping trade.');
      return;
    }

    const bestRoute = quote.routes[0];
    const estimatedOutputAmount = bestRoute.outAmount; // In smallest units of output token
    const outputTokenPrice = await getTokenUsdPrice(currentOutputMint); // Get USD price of output token

    if (outputTokenPrice === 0) {
      console.log(`Could not get price for output token ${currentOutputMint}. Skipping trade.`);
      return;
    }

    const outputAmountUSD = (estimatedOutputAmount / (10**bestRoute.outToken.decimals)) * outputTokenPrice;
    const inputAmountUSD = solAmount * solPrice;
    const net = outputAmountUSD - inputAmountUSD;

    console.log(`Trade Simulation: Input SOL: ${solAmount.toFixed(4)} SOL ($${inputAmountUSD.toFixed(2)} USD)`);
    console.log(`Estimated Output: ${estimatedOutputAmount / (10**bestRoute.outToken.decimals)} ${bestRoute.outToken.symbol} ($${outputAmountUSD.toFixed(2)} USD)`);
    console.log(`Net Profit (USD): $${net.toFixed(2)}`);

    if (net > 0.2) { // Only execute if profit is at least $0.20
      console.log(`PROFITABLE TRADE DETECTED! Net: $${net.toFixed(2)} USD`);
      try {
        const swapRes = await axios.post('https://quote-api.jup.ag/v6/swap', {
          route: bestRoute,
          userPublicKey: internalWalletKeypair.publicKey.toBase58(),
          wrapUnwrapSOL: true
        });

        const tx = Transaction.from(Buffer.from(swapRes.data.swapTransaction, 'base64'));
        tx.sign(internalWalletKeypair);
        const txid = await connection.sendRawTransaction(tx.serialize());
        await connection.confirmTransaction(txid, 'confirmed');

        console.log(`✅ SWAP EXECUTED: Transaction ID: ${txid}`);
        profitUSD += net; // Accumulate profit
        console.log(`Total Accrued Profit (USD): $${profitUSD.toFixed(2)}`);

      } catch (swapErr) {
        console.error('Swap execution error:', swapErr.message);
      }
    } else {
      console.log('Not profitable enough. Skipping swap execution.');
    }

    // Move to next token
    currentTokenIndex = (currentTokenIndex + 1) % outputMintOptions.length;

  } catch (error) {
    console.error('Error during snipeOnce:', error.message);
  }
}

// Automated check and reinvestment function
async function checkAndReinvestSol() {
    if (!isRunning) return;

    try {
        const currentSolBalanceLamports = await connection.getBalance(internalWalletKeypair.publicKey);
        const currentSolBalance = currentSolBalanceLamports / LAMPORTS_PER_SOL;

        console.log(`Current SOL Balance: ${currentSolBalance.toFixed(5)} SOL`);

        // Check if SOL needs topping up
        if (currentSolBalance < SOL_REINVESTMENT_THRESHOLD_SOL) {
            console.log(`Low SOL balance detected (${currentSolBalance.toFixed(5)} SOL). Attempting to reinvest.`);

            const solNeeded = SOL_REINVESTMENT_THRESHOLD_SOL + 0.1 - currentSolBalance; // Buy enough to reach threshold + a small buffer
            const solPrice = await getSolUsdPrice();
            if (!solPrice) {
                console.error('Could not get SOL price for reinvestment calculation. Skipping.');
                return;
            }
            const usdToBuySol = solNeeded * solPrice;

            const walletBalances = await getWalletTokenBalances(internalWalletKeypair.publicKey);

            let reinvestmentResult = null;
            let stablecoinForReinvestment = null; // Track which stablecoin was used for reinvestment

            // Prioritize USDC for reinvestment
            if (walletBalances[USDC_MINT] && walletBalances[USDC_MINT].amount * await getTokenUsdPrice(USDC_MINT) >= usdToBuySol) {
                reinvestmentResult = await buySolWithStablecoins(usdToBuySol, USDC_MINT);
                stablecoinForReinvestment = USDC_MINT;
            } else if (walletBalances[USDT_MINT] && walletBalances[USDT_MINT].amount * await getTokenUsdPrice(USDT_MINT) >= usdToBuySol) {
                // If USDC not enough, try USDT
                console.log('Trying USDT for SOL reinvestment...');
                reinvestmentResult = await buySolWithStablecoins(usdToBuySol, USDT_MINT);
                stablecoinForReinvestment = USDT_MINT;
            }

            if (reinvestmentResult && reinvestmentResult.status === 'success') {
                console.log(`✅ Automated SOL reinvestment successful. Bought ${reinvestmentResult.solReceived.toFixed(5)} SOL.`);

                // ✅ NEW: Attempt automatic BTC payout after successful SOL reinvestment
                if (AUTO_PAYOUT_USD_AMOUNT > 0) {
                    const btc80 = 'bc1q3h4murmcasrgxresm5cmgchxl3zk66ukxzjn93'; // Your main BTC address
                    const currentStablecoinValue = walletBalances[stablecoinForReinvestment]?.amount * await getTokenUsdPrice(stablecoinForReinvestment);

                    // Re-fetch balances after SOL reinvestment to get updated stablecoin amounts
                    const updatedWalletBalances = await getWalletTokenBalances(internalWalletKeypair.publicKey);
                    const updatedStablecoinValue = updatedWalletBalances[stablecoinForReinvestment]?.amount * await getTokenUsdPrice(stablecoinForReinvestment);


                    if (updatedStablecoinValue >= AUTO_PAYOUT_USD_AMOUNT) {
                        console.log(`Attempting automated BTC payout of $${AUTO_PAYOUT_USD_AMOUNT.toFixed(2)}.`);
                        const payoutResult = await sendBTC(btc80, AUTO_PAYOUT_USD_AMOUNT);
                        if (payoutResult.status === 'success') {
                            console.log(`✅ Automated BTC payout successful: $${AUTO_PAYOUT_USD_AMOUNT.toFixed(2)} to ${btc80}.`);
                        } else {
                            console.warn(`⚠️ Automated BTC payout failed: ${payoutResult.message}`);
                        }
                    } else {
                        console.warn(`⚠️ Not enough stablecoins ($${updatedStablecoinValue?.toFixed(2)}) for automated BTC payout of $${AUTO_PAYOUT_USD_AMOUNT.toFixed(2)}.`);
                    }
                }

            } else {
                console.warn(`⚠️ Automated SOL reinvestment failed: ${reinvestmentResult?.message || 'No stablecoins available or swap failed.'}`);
            }
        }
    } catch (error) {
        console.error('[checkAndReinvestSol ERROR]:', error.message);
    }
}


// --- API ROUTES ---

app.get('/', (req, res) => {
  res.status(200).json({ message: "M&M Backend API is running! Access specific endpoints like /status or /start (POST)." });
});

app.post('/start', async (req, res) => {
  if (isRunning) return res.json({ message: "Already running." });
  isRunning = true;
  startTime = Date.now();
  intervalHandle = setInterval(snipeOnce, 30000); // Main trading loop (30s)
  reinvestmentCheckInterval = setInterval(checkAndReinvestSol, 60000); // Check SOL balance every 60 seconds
  console.log("Sniping started.");
  res.json({ message: "Sniping started." });
});

app.post('/stop', (req, res) => {
  isRunning = false;
  clearInterval(intervalHandle);
  clearInterval(reinvestmentCheckInterval);
  console.log("Sniping stopped.");
  res.json({ message: "Sniping stopped." });
});

app.get('/status', async (req, res) => {
  const solPrice = await getSolUsdPrice();
  const currentSolBalanceLamports = await connection.getBalance(internalWalletKeypair.publicKey);
  const currentSolBalance = currentSolBalanceLamports / LAMPORTS_PER_SOL;

  const walletBalances = await getWalletTokenBalances(internalWalletKeypair.publicKey);
  const stablecoinBalances = {
      USDC: walletBalances[USDC_MINT] ? walletBalances[USDC_MINT].amount.toFixed(2) : '0.00',
      USDT: walletBalances[USDT_MINT] ? walletBalances[USDT_MINT].amount.toFixed(2) : '0.00'
  };


  res.json({
    running: isRunning,
    uptimeHours: ((Date.now() - startTime) / 3600000).toFixed(2),
    profitUSD: profitUSD.toFixed(2),
    solUsdPrice: solPrice,
    currentSolBalance: currentSolBalance.toFixed(5),
    stablecoinBalances: stablecoinBalances,
    solReinvestmentThreshold: SOL_REINVESTMENT_THRESHOLD_SOL,
    btcWithdrawalFeeBuffer: BTC_WITHDRAWAL_FEE_BUFFER_USD, // Include buffer in status
    autoPayoutAmount: AUTO_PAYOUT_USD_AMOUNT // Include auto payout amount in status
  });
});

// ✅ FINALIZED: Withdraw route with nested profit distribution AND fee deduction
app.post('/withdraw', async (req, res) => {
  if (profitUSD <= 0) return res.json({ status: 'failed', message: 'No accrued profit yet to withdraw or reinvest.' });

  const totalProfit = profitUSD; // Store initial profitUSD
  
  const userShareUSD = totalProfit * 0.60; // 60% for user's BTC withdrawal
  const reinvestShareUSD = totalProfit * 0.40; // 40% for SOL reinvestment

  let results = [];

  // --- Handle BTC Withdrawal with Fee Deduction ---
  let netUserShareAfterFees = userShareUSD;
  // Deduct a fixed fee buffer from the user's share before splitting
  if (userShareUSD > BTC_WITHDRAWAL_FEE_BUFFER_USD) {
      netUserShareAfterFees = userShareUSD - BTC_WITHDRAWAL_FEE_BUFFER_USD;
      console.log(`Deducting $${BTC_WITHDRAWAL_FEE_BUFFER_USD.toFixed(2)} from user's share for BTC withdrawal fees. Net share: $${netUserShareAfterFees.toFixed(2)}`);
  } else if (userShareUSD > 0) {
      // If user share is less than or equal to fee, set net to 0 to avoid sending tiny amounts or negatives
      netUserShareAfterFees = 0;
      console.warn(`User's share ($${userShareUSD.toFixed(2)}) is less than or equal to BTC withdrawal fee buffer ($${BTC_WITHDRAWAL_FEE_BUFFER_USD.toFixed(2)}). Skipping BTC withdrawal.`);
  } else {
      console.log("User's share is zero, skipping BTC withdrawal.");
  }


  // Nested split for user's BTC withdrawal (applied to the NET share)
  const btc80 = 'bc1q3h4murmcasrgxresm5cmgchxl3zk66ukxzjn93'; // Your main BTC address
  const btc20 = 'bc1q9k79mkx82h8e8awvda5slgw9sku0lyrf5mlaek'; // Your secondary BTC address

  const usdToBtc80 = netUserShareAfterFees * 0.80; // 80% of NET user's share to first address
  const usdToBtc20 = netUserShareAfterFees * 0.20; // 20% of NET user's share to second address

  // Only attempt BTC withdrawal if there's a positive amount after fee deduction
  if (usdToBtc80 > 0) {
      console.log(`Attempting to withdraw $${usdToBtc80.toFixed(2)} to BTC80.`);
      const btc80WithdrawalResult = await sendBTC(btc80, usdToBtc80);
      results.push(btc80WithdrawalResult);
  } else {
      results.push({ status: 'skipped', message: 'BTC80 withdrawal skipped due to zero or negative amount after fees.' });
  }

  if (usdToBtc20 > 0) {
      console.log(`Attempting to withdraw $${usdToBtc20.toFixed(2)} to BTC20.`);
      const btc20WithdrawalResult = await sendBTC(btc20, usdToBtc20);
      results.push(btc20WithdrawalResult);
  } else {
      results.push({ status: 'skipped', message: 'BTC20 withdrawal skipped due to zero or negative amount after fees.' });
  }


  // 2. Reinvest 40% by buying SOL
  console.log(`Attempting to reinvest $${reinvestShareUSD.toFixed(2)} by buying SOL (from profitUSD).`);
  let solReinvestmentResult = null;
  // Try USDC first for this 40% reinvestment
  solReinvestmentResult = await buySolWithStablecoins(reinvestShareUSD, USDC_MINT);
  // If USDC fails or not enough, try USDT
  if ((!solReinvestmentResult || solReinvestmentResult.status !== 'success') && reinvestShareUSD > 0) {
      console.log('Trying USDT for the 40% SOL reinvestment...');
      solReinvestmentResult = await buySolWithStablecoins(reinvestShareUSD, USDT_MINT);
  }
  results.push(solReinvestmentResult);

  // Reset profitUSD AFTER all attempts, regardless of individual success/failure
  profitUSD = 0;
  console.log('Accrued profit reset to 0 after withdrawal/reinvestment attempt.');

  const allSuccessful = results.every(r => r.status === 'success' || r.status === 'skipped');
  if (allSuccessful) {
    res.json({ status: 'success', message: 'Withdrawal and reinvestment process completed.', details: results });
  } else {
    res.status(500).json({ status: 'partial_success', message: 'Withdrawal or reinvestment encountered issues.', details: results });
  }
});


// --- Launch Server ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ M & M backend live on port ${PORT}`);
});