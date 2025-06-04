const express = require('express');
const {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  Transaction, // Keeping Transaction as per your existing code, though VersionedTransaction is newer
  VersionedTransaction, // Added for Jupiter swap response
  TransactionMessage, // Added for Jupiter swap response
} = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');
const cors = require('cors');
// Added for SPL token handling for SOL replenishment
const {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount, // Added for robust token transfers
  createTransferInstruction, // Added for robust token transfers
} = require('@solana/spl-token');


const app = express();
app.use(express.json());
// Ensure CORS is configured for your frontend domain if different
app.use(cors({ origin: true, credentials: true })); 

// === ENVIRONMENT CONFIG ===
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// Your existing API Keys and Addresses
const JUPITER_API_KEY = process.env.JUPITER_API_KEY; // Only needed for private Jupiter endpoints or higher rate limits
const BLOCKONOMICS_API_KEY = process.env.BLOCKONOMICS_API_KEY;
const PLATFORM_SOLANA_ADDRESS = process.env.PLATFORM_SOLANA_ADDRESS;

let internalWalletKeypair;
let PLATFORM_SOLANA_PUBLIC_KEY;

// Initialize internal wallet from private key
try {
    if (!process.env.SOLANA_PRIVATE_KEY_BASE58) {
        throw new Error("SOLANA_PRIVATE_KEY_BASE58 environment variable is not set.");
    }
    const decodedPrivateKey = bs58.decode(process.env.SOLANA_PRIVATE_KEY_BASE58);
    internalWalletKeypair = Keypair.fromSecretKey(decodedPrivateKey);
    console.log("Internal wallet loaded:", internalWalletKeypair.publicKey.toBase58());
} catch (error) {
    console.error("Failed to load internal wallet from SOLANA_PRIVATE_KEY_BASE58. Please check your .env file:", error.message);
    process.exit(1);
}

// Initialize platform public key
try {
    if (!PLATFORM_SOLANA_ADDRESS) {
        throw new Error("PLATFORM_SOLANA_ADDRESS environment variable is not set.");
    }
    PLATFORM_SOLANA_PUBLIC_KEY = new PublicKey(PLATFORM_SOLANA_ADDRESS);
    console.log("Platform public key loaded:", PLATFORM_SOLANA_PUBLIC_KEY.toBase58());
} catch (error) {
    console.error("Failed to load platform public key from PLATFORM_SOLANA_ADDRESS. Please check your .env file:", error.message);
    process.exit(1);
}

// === BOT CONFIGURATION ===
// Your existing profit config
let isRunning = false;
let profitUSD = 0; // Total accumulated profit from all trades
let accumulatedUserProfitUSD = 0; // User's 60% share, accumulating for auto-payout
let startTime = null;
let intervalHandle = null; // For the main sniping loop
let replenishIntervalId = null; // For SOL replenishment check

// Existing payout thresholds
const AUTO_PAYOUT_USD_AMOUNT = parseFloat(process.env.AUTO_PAYOUT_USD_AMOUNT) || 50;
const BTC_WITHDRAWAL_FEE_BUFFER_USD = parseFloat(process.env.BTC_WITHDRAWAL_FEE_BUFFER_USD) || 20;

// New SOL replenishment configuration
const SOL_REINVESTMENT_THRESHOLD_SOL = parseFloat(process.env.SOL_REINVESTMENT_THRESHOLD_SOL) || 0.5; // Trigger replenishment if SOL drops below this
const SOL_REINVESTMENT_TOPUP_AMOUNT_USD = parseFloat(process.env.SOL_REINVESTMENT_TOPUP_AMOUNT_USD) || 20; // Amount to swap for SOL in USD
const MIN_SWAP_VALUE_USD = parseFloat(process.env.MIN_SWAP_VALUE_USD) || 1; // Minimum USD value of a token to consider for swapping


// === MULTI-TOKEN ROTATION & MINT ADDRESSES ===
// Common Token Mint Addresses (Standardized for use with Jupiter)
const SOL_MINT_ADDRESS = new PublicKey('So11111111111111111111111111111111111111112'); // SOL (native mint)
const USDC_MINT_ADDRESS = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTD1v'); // USDC
const USDT_MINT_ADDRESS = new PublicKey('Es9vMFrzaCERUjBz2X4T5UoD7gwo8pWxSyh5MZgibY4M'); // USDT

// Your existing output mint options for multi-token rotation
const outputMintOptions = [
  USDC_MINT_ADDRESS.toBase58(), // USDC
  USDT_MINT_ADDRESS.toBase58(), // USDT
  SOL_MINT_ADDRESS.toBase58(), // SOL
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


// === PRICE & TRADE UTILITIES ===

/**
 * Sends and confirms a Solana transaction.
 * @param {Connection} connection The Solana connection object.
 * @param {Transaction | VersionedTransaction} transaction The transaction to send.
 * @param {Array<Keypair>} signers An array of Keypairs to sign the transaction.
 * @returns {Promise<string>} The transaction signature.
 */
async function sendAndConfirmTransaction(connection, transaction, signers) {
    try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        if (transaction instanceof VersionedTransaction) {
             // For VersionedTransaction, blockhash is part of the message already
        } else {
            transaction.recentBlockhash = blockhash;
            transaction.lastValidBlockHeight = lastValidBlockHeight;
        }

        transaction.sign(signers);

        const rawTransaction = transaction.serialize();
        const signature = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true, // Be cautious with skipPreflight in production
            preflightCommitment: 'confirmed'
        });

        await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight
        }, 'confirmed');
        console.log(`Transaction confirmed: ${signature}`);
        return signature;
    } catch (error) {
        console.error("Error sending/confirming transaction:", error);
        throw error;
    }
}

/**
 * Fetches the current USD price of a given token mint using Jupiter's Price API.
 * @param {string} mintAddress The Base58 string of the token's mint address.
 * @returns {Promise<number>} The price of the token in USD, or 0 if not found/error.
 */
async function getTokenPriceInUSD(mintAddress) {
  try {
    const response = await axios.get(`https://price.jup.ag/v4/price?ids=${mintAddress}`);
    if (response.data && response.data.data && response.data.data[mintAddress]) {
      return response.data.data[mintAddress].price;
    }
    return 0;
  } catch (error) {
    console.error(`Error fetching price for ${mintAddress}:`, error.message);
    return 0;
  }
}

async function getJupiterQuote(inputMint, outputMint, amount) {
  try {
    const res = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: { inputMint, outputMint, amount, slippageBps: 100 },
      // Authorization header usually not needed for public quote API endpoints
      // headers: { Authorization: `Bearer ${JUPITER_API_KEY}` },
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
    console.error(`[BLOCKONOMICS] BTC Send Error to ${toAddress} for $${amountUSD}:`, err.message);
    return { status: 'failed', address: toAddress, message: err.message };
  }
}


// === Core Bot Logic: SOL Replenishment (New Feature) ===
async function replenishSolBalance() {
    try {
        const currentSolBalanceLamports = await connection.getBalance(internalWalletKeypair.publicKey);
        console.log(`Current SOL Balance: ${(currentSolBalanceLamports / LAMPORTS_PER_SOL).toFixed(5)} SOL`);

        if (currentSolBalanceLamports < SOL_REINVESTMENT_THRESHOLD_SOL * LAMPORTS_PER_SOL) {
            console.log(`SOL balance (${(currentSolBalanceLamports / LAMPORTS_PER_SOL).toFixed(5)} SOL) is below threshold (${SOL_REINVESTMENT_THRESHOLD_SOL} SOL). Initiating SOL replenishment.`);

            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
                internalWalletKeypair.publicKey, {
                    programId: TOKEN_PROGRAM_ID
                }
            );

            let potentialSwapSources = [];

            for (const account of tokenAccounts.value) {
                const mintAddress = account.account.data.parsed.info.mint;
                const uiAmount = account.account.data.parsed.info.tokenAmount.uiAmount;
                const decimals = account.account.data.parsed.info.tokenAmount.decimals;

                // Ensure it's not SOL itself and has some balance
                if (uiAmount > 0 && mintAddress !== SOL_MINT_ADDRESS.toBase58()) {
                    const price = await getTokenPriceInUSD(mintAddress);
                    const usdValue = uiAmount * price;

                    if (usdValue >= MIN_SWAP_VALUE_USD) { // Only consider if it's worth at least $1
                        potentialSwapSources.push({
                            mint: new PublicKey(mintAddress),
                            uiAmount,
                            decimals,
                            usdValue,
                            price,
                            isStablecoin: (mintAddress === USDC_MINT_ADDRESS.toBase58() || mintAddress === USDT_MINT_ADDRESS.toBase58())
                        });
                    }
                }
            }

            // Prioritize stablecoins, then highest USD value
            potentialSwapSources.sort((a, b) => {
                if (a.isStablecoin && !b.isStablecoin) return -1;
                if (!a.isStablecoin && b.isStablecoin) return 1;
                return b.usdValue - a.usdValue;
            });

            if (potentialSwapSources.length === 0) {
                console.warn("No suitable tokens found in wallet to swap for SOL replenishment.");
                return false;
            }

            let selectedSource = null;
            let inputTokenAmountRaw = 0;
            let inputMint = null;

            // Try to find a source that can cover the full swapAmountUsd
            for (const source of potentialSwapSources) {
                if (source.usdValue >= SOL_REINVESTMENT_TOPUP_AMOUNT_USD) {
                    selectedSource = source;
                    inputTokenAmountRaw = Math.floor((SOL_REINVESTMENT_TOPUP_AMOUNT_USD / source.price) * (10 ** source.decimals));
                    inputMint = source.mint;
                    console.log(`Using ~${(inputTokenAmountRaw / (10 ** source.decimals)).toFixed(4)} ${selectedSource.mint.toBase58().substring(0, 5)}... (worth ~$${SOL_REINVESTMENT_TOPUP_AMOUNT_USD.toFixed(2)}) for SOL replenishment.`);
                    break;
                }
            }

            // If no single source covers the full amount, use the largest available source
            if (!selectedSource) {
                selectedSource = potentialSwapSources[0]; // Take the highest valued one
                inputTokenAmountRaw = Math.floor(selectedSource.uiAmount * (10 ** selectedSource.decimals));
                inputMint = selectedSource.mint;
                console.warn(`Insufficient single source to cover full $${SOL_REINVESTMENT_TOPUP_AMOUNT_USD.toFixed(2)} replenishment. Using all of ~${(selectedSource.uiAmount).toFixed(4)} ${selectedSource.mint.toBase58().substring(0,5)}... (worth ~$${selectedSource.usdValue.toFixed(2)}) for SOL replenishment.`);
            }

            if (!selectedSource || inputTokenAmountRaw === 0) {
                console.warn("Could not find a suitable token source with enough value for SOL replenishment.");
                return false;
            }

            const quoteResponse = await getJupiterQuote(inputMint.toBase58(), SOL_MINT_ADDRESS.toBase58(), inputTokenAmountRaw);

            if (!quoteResponse) {
                console.error("Failed to get swap quote from Jupiter for SOL replenishment.");
                return false;
            }

            console.log(`Jupiter Quote: ${quoteResponse.outAmount / LAMPORTS_PER_SOL} SOL for ${inputTokenAmountRaw / (10 ** selectedSource.decimals)} ${selectedSource.mint.toBase58().substring(0, 5)}...`);

            const swapResponse = await axios.post('https://quote-api.jup.ag/v6/swap', {
                quoteResponse: quoteResponse, // Pass the entire quoteResponse object
                userPublicKey: internalWalletKeypair.publicKey.toBase58(),
                wrapUnwrapSOL: true,
            }, {
                // Authorization header usually not needed for public swap API endpoints
                // headers: { Authorization: `Bearer ${JUPITER_API_KEY}` }
            });

            const { swapTransaction } = swapResponse.data;

            if (!swapTransaction) {
                console.error("Failed to get swap transaction from Jupiter.");
                return false;
            }

            const transactionBuffer = Buffer.from(swapTransaction, 'base64');
            // Jupiter's V6 API returns VersionedTransaction.
            const transaction = VersionedTransaction.deserialize(transactionBuffer);

            const txid = await sendAndConfirmTransaction(connection, transaction, [internalWalletKeypair]);

            console.log(`Successfully replenished SOL. Transaction ID: ${txid}`);
            return true;

        } else {
            console.log("SOL balance is sufficient. No replenishment needed.");
            return false;
        }
    } catch (error) {
        console.error("Error during SOL replenishment:", error);
        return false;
    }
}


// === MAIN SNIPING LOOP (User's Existing Logic + Minor Enhancements) ===
async function snipeOnce() {
  if (!isRunning) return;

  const solPrice = await getTokenPriceInUSD(SOL_MINT_ADDRESS.toBase58()); // Use universal price fetcher
  if (!solPrice) {
      console.warn("Could not get SOL price, skipping snipe attempt.");
      return;
  }

  const inputMint = SOL_MINT_ADDRESS.toBase58(); // Input is SOL
  const outputMint = outputMintOptions[currentTokenIndex % outputMintOptions.length];
  currentTokenIndex++;
  const inputAmountSol = 0.1;
  const inputAmountLamports = Math.round(inputAmountSol * LAMPORTS_PER_SOL);

  const quote = await getJupiterQuote(inputMint, outputMint, inputAmountLamports);
  if (!quote || !quote.routes?.length) {
      console.log(`No Jupiter quote found for ${inputMint.substring(0,5)}... to ${outputMint.substring(0,5)}...`);
      return;
  }

  const bestRoute = quote.routes[0];
  console.log(`Attempting swap: ${inputAmountSol} SOL to ${bestRoute.outAmount / (10 ** bestRoute.outToken.decimals)} ${bestRoute.outToken.symbol}`);

  try {
    const swapRes = await axios.post('https://quote-api.jup.ag/v6/swap', {
      quoteResponse: bestRoute, // Pass the entire quoteResponse object
      userPublicKey: internalWalletKeypair.publicKey.toBase58(), // Use bot's wallet for swap
      wrapUnwrapSOL: true
    }, {
      // Authorization header usually not needed for public swap API endpoints
      // headers: { Authorization: `Bearer ${JUPITER_API_KEY}` }
    });

    const { swapTransaction } = swapRes.data;

    if (!swapTransaction) {
        console.error("Failed to get swap transaction from Jupiter.");
        return;
    }

    const transactionBuffer = Buffer.from(swapTransaction, 'base64');
    // Jupiter's V6 API returns VersionedTransaction.
    const transaction = VersionedTransaction.deserialize(transactionBuffer);

    // Use the robust sendAndConfirmTransaction
    const txid = await sendAndConfirmTransaction(connection, transaction, [internalWalletKeypair]);
    console.log(`Swap successful! TxID: ${txid}`);

    // --- Profit Calculation and Payout Logic (Existing from your code) ---
    // Fetch the price of the output token to calculate its USD value
    const outputTokenPrice = await getTokenPriceInUSD(bestRoute.outToken.mint);
    if (!outputTokenPrice) {
        console.warn(`Could not get price for ${bestRoute.outToken.symbol}, profit calculation may be inaccurate.`);
        return; // Or handle this error more gracefully
    }

    const valueUSD = (bestRoute.outAmount / (10 ** bestRoute.outToken.decimals)) * outputTokenPrice;
    const costUSD = inputAmountSol * solPrice;
    const net = valueUSD - costUSD;

    if (net > 0.2) { // Only consider profits above 0.2 USD
      profitUSD += net; // Accumulate total profit
      const userShare = net * 0.6;
      // const reinvestShare = net * 0.4; // Already calculated implicitly
      accumulatedUserProfitUSD += userShare;
      console.log(`Swapped to ${bestRoute.outToken.symbol || 'Token'}: +$${net.toFixed(2)} | 60% ($${userShare.toFixed(2)}) to payout, 40% retained.`);

      // --- Auto Payout Check (Existing from your code) ---
      if (accumulatedUserProfitUSD >= AUTO_PAYOUT_USD_AMOUNT) {
        console.log(`Accumulated user profit ($${accumulatedUserProfitUSD.toFixed(2)}) meets payout threshold ($${AUTO_PAYOUT_USD_AMOUNT.toFixed(2)}). Initiating BTC payout.`);

        const payout = accumulatedUserProfitUSD - BTC_WITHDRAWAL_FEE_BUFFER_USD;
        if (payout <= 0) {
            console.warn(`Calculated BTC payout amount after fee is $${payout.toFixed(2)}. Skipping payout.`);
            return;
        }

        // Hardcoded BTC addresses from your code
        const btc80 = 'bc1q3h4murmcasrgxresm5cmgchxl3zk66ukxzjn93';
        const btc20 = 'bc1q9k79mkx82h8e8awvda5slgw9sku0lyrf5mlaek';
        const [usd80, usd20] = [payout * 0.8, payout * 0.2];

        const r1 = await sendBTC(btc80, usd80);
        const r2 = await sendBTC(btc20, usd20);

        if (r1.status === 'success' && r2.status === 'success') {
          accumulatedUserProfitUSD = 0; // Reset after successful payout
          console.log(`✅ Auto payout success: $${usd80.toFixed(2)} and $${usd20.toFixed(2)} BTC sent.`);
        } else {
          console.warn(`⚠️ Auto payout partially failed. Payout not reset to retry.`);
          // If partially failed, we don't reset accumulatedUserProfitUSD
          // so it attempts again next cycle if conditions are met.
        }
      }

    } else {
      console.log(`⚠️ Low profit: $${net.toFixed(2)} — Skipped`);
    }

  } catch (err) {
    console.error('[SWAP EXECUTION ERROR]', err.message);
    // Log details of transaction if it's a known error type
    if (err.response?.data?.error) {
        console.error('Swap API error details:', err.response.data.error);
    }
  }
}

// === ROUTES ===

// Root endpoint to confirm API is running (ADDED)
app.get('/', (req, res) => {
    res.json({ message: "M&M Backend API is running! Access specific endpoints like /status or /start (POST)." });
});

app.post('/start', async (req, res) => {
  if (isRunning) return res.json({ message: "Already running." });
  isRunning = true;
  startTime = Date.now();
  intervalHandle = setInterval(snipeOnce, 30000); // Main sniping loop runs every 30 seconds

  // Start periodic SOL replenishment check (New)
  replenishIntervalId = setInterval(async () => {
      if (isRunning) { // Only replenish if bot is running
          await replenishSolBalance();
      } else {
          clearInterval(replenishIntervalId); // Stop if bot stops
          replenishIntervalId = null;
      }
  }, 5 * 60 * 1000); // Check every 5 minutes

  res.json({ message: "Sniping started." });
});

app.post('/stop', (req, res) => {
  if (!isRunning) return res.json({ message: "Not running." });
  isRunning = false;
  clearInterval(intervalHandle);
  intervalHandle = null;

  // Stop SOL replenishment interval (New)
  if (replenishIntervalId) {
      clearInterval(replenishIntervalId);
      replenishIntervalId = null;
  }
  res.json({ message: "Sniping stopped." });
});

app.get('/status', async (req, res) => {
  const solPrice = await getTokenPriceInUSD(SOL_MINT_ADDRESS.toBase58()); // Use universal price fetcher
  let currentSolBalance = "0.00000";
  let usdcBalance = "0.00";
  let usdtBalance = "0.00";

  try {
      const balance = await connection.getBalance(internalWalletKeypair.publicKey);
      currentSolBalance = (balance / LAMPORTS_PER_SOL).toFixed(5);
  } catch (error) {
      console.error("Error fetching current SOL balance for status:", error.message);
  }

  // Fetch USDC balance
  try {
      const usdcAccount = getAssociatedTokenAddressSync(USDC_MINT_ADDRESS, internalWalletKeypair.publicKey, true);
      const usdcTokenBalance = await connection.getTokenAccountBalance(usdcAccount);
      usdcBalance = usdcTokenBalance.value.uiAmount.toFixed(2);
  } catch (error) { /* console.warn("Could not get USDC balance:", error.message); */ } // ATA might not exist

  // Fetch USDT balance
  try {
      const usdtAccount = getAssociatedTokenAddressSync(USDT_MINT_ADDRESS, internalWalletKeypair.publicKey, true);
      const usdtTokenBalance = await connection.getTokenAccountBalance(usdtAccount);
      usdtBalance = usdtTokenBalance.value.uiAmount.toFixed(2);
  } catch (error) { /* console.warn("Could not get USDT balance:", error.message); */ } // ATA might not exist


  const uptimeHours = startTime ? ((Date.now() - startTime) / 3600000).toFixed(2) : "0.00";

  res.json({
    running: isRunning,
    uptimeHours: uptimeHours,
    profitUSD: profitUSD.toFixed(2), // Total bot profit
    userAccumulated: accumulatedUserProfitUSD.toFixed(2), // User's 60% share
    solUsdPrice: solPrice.toFixed(2),
    currentSolBalance: currentSolBalance,
    stablecoinBalances: {
        USDC: usdcBalance,
        USDT: usdtBalance
    },
    solReinvestmentThreshold: SOL_REINVESTMENT_THRESHOLD_SOL,
    solTopupAmountUsd: SOL_REINVESTMENT_TOPUP_AMOUNT_USD,
    autoPayoutAmount: AUTO_PAYOUT_USD_AMOUNT,
    btcWithdrawalFeeBuffer: BTC_WITHDRAWAL_FEE_BUFFER_USD
  });
});

// New endpoint for manually testing profit recording
app.post('/test-profit', (req, res) => {
    const { amount } = req.body;
    if (typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ message: "Please provide a positive 'amount' (number) in the request body." });
    }
    // Directly inject into profit variables, simulating a trade
    profitUSD += amount;
    const userShare = amount * 0.6;
    // const reinvestShare = amount * 0.4; // Not explicitly tracked here
    accumulatedUserProfitUSD += userShare;

    console.log(`Manual profit injected: $${amount.toFixed(2)}. Total Profit: $${profitUSD.toFixed(2)}, User Accrued: $${accumulatedUserProfitUSD.toFixed(2)}`);

    // Optionally, trigger an immediate payout check if needed, but normally it's done by snipeOnce or separate interval
    // If you want it to trigger immediately for test-profit, uncomment below:
    // snipeOnce(); // This would trigger a full snipe and profit check
    // Alternatively, copy the payout check logic from snipeOnce here if you want only payout check
    
    // For simplicity, just update the variables and let the periodic snipeOnce handle the payout check.
    // However, if you need an immediate payout test:
    if (accumulatedUserProfitUSD >= AUTO_PAYOUT_USD_AMOUNT) {
        // This is a simplified direct trigger without full snipe logic.
        // It relies on snipeOnce's BTC payout logic for the actual send.
        // In a real scenario, you'd call a dedicated payout function.
        // For direct test, you might want to call the BTC send part directly.
        // For now, it will be handled by the next snipeOnce run.
        console.log("Manual profit injection triggered payout threshold. Next snipe cycle will attempt payout.");
    }

    res.json({
        message: `Profit of $${amount.toFixed(2)} recorded.`,
        currentTotalProfit: profitUSD.toFixed(2),
        currentUserAccumulated: accumulatedUserProfitUSD.toFixed(2)
    });
});


// === SERVER START ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ M & M backend live on port ${PORT}`);
});