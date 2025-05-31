const express = require('express');
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');
const cors = require('cors'); // Ensure this line is present and at the top with other requires

const app = express();
app.use(express.json());

// --- START CORS CONFIGURATION ---
// IMPORTANT: Add all origins that need to access your backend here.
// 'https://mm-frontend-lemon.vercel.app' is for your Vercel frontend.
// 'https://ipfs.io' is crucial because your frontend is deployed via an IPFS gateway.
const allowedOrigins = [
  'https://mm-frontend-lemon.vercel.app',
  'https://ipfs.io', // <--- This is the crucial addition for your IPFS-hosted frontend
  'https://ipfs.io/ipfs/QmcNQAg9aBGBJjEn2xRpsRzSX1EVRUyNqErANVfHTUwfPN/', // Added the specific IPFS mirror site origin
  // If you are running your frontend locally for testing, add 'http://localhost:3000' (or your local port):
  // 'http://localhost:3000'
  // Add any other specific IPFS gateways or Vercel frontend URLs you are using:
  // 'https://your-actual-frontend-url-from-browser-network-tab.vercel.app',
  // 'https://another-ipfs-gateway.com',
];

const corsOptions = {
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl requests)
    // or if the origin is in our allowed list
    if (!origin || allowedOrigins.includes(origin)) { // Using .includes() is more modern than .indexOf() !== -1
      callback(null, true);
    } else {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      callback(new Error(msg), false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Explicitly allow common HTTP methods
  allowedHeaders: ['Content-Type', 'Authorization'], // Allow headers your frontend might send
  credentials: true, // Allow cookies to be sent (if your app uses them)
  optionsSuccessStatus: 200 // For preflight requests (OPTIONS method)
};

// Use the configured CORS middleware. This MUST be before your routes.
app.use(cors(corsOptions));
// --- END CORS CONFIGURATION ---

let isRunning = false;
let profitUSD = 0;
let startTime = null;
let transactionMonitorInterval = null;

// Solana Configuration
const SOLANA_RPC_URL = 'https://fittest-patient-pond.solana-mainnet.quiknode.pro/de9d37470b2873fedf650c074df9c9aa8519f5d9/';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// Internal Wallet Keypair (loaded securely from env)
let internalWalletKeypair;

// Environment Variables (MUST be set in .env or Vercel settings)
// PLATFORM_SOLANA_ADDRESS is the public key of the wallet used for sniping AND receiving user payouts
const PLATFORM_SOLANA_ADDRESS = process.env.PLATFORM_SOLANA_ADDRESS;
const PLATFORM_SOLANA_PUBLIC_KEY = PLATFORM_SOLANA_ADDRESS ? new PublicKey(PLATFORM_SOLANA_ADDRESS) : null;

// Jupiter Aggregator Program ID (for identifying transactions, not direct API calls)
const JUPITER_AGGREGATOR_PROGRAM_ID = new PublicKey('JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB');

// Developer BTC Addresses
const DEV_BTC_ADDRESSES = [
    'bc1q9k79mkx82h8e8awvda5slgw9sku0lyrf5mlaek',
    'bc1ql37nntg829w2vyufpheg9wxdutl8m4zjvjudt2'
];

// Blockonomics API Key (loaded securely from env)
const BLOCKONOMICS_API_KEY = process.env.BLOCKONOMICS_API_KEY;

// Loss Protection Thresholds
const MIN_PROFIT_THRESHOLD_USD = 0.20; // Example: $0.20
const MAX_PRICE_IMPACT_PCT = 0.005; // Example: 0.5% (as a decimal)

// --- CoinGecko Price Caching ---
let cachedSolUsdPrice = 0;
let lastPriceFetchTime = 0;
const PRICE_CACHE_DURATION = 5 * 60 * 1000; // Cache for 5 minutes (300,000 ms)

// --- Helper Functions ---

// Function to fetch SOL/USD price with caching
async function getSolUsdPrice() {
    if (Date.now() - lastPriceFetchTime < PRICE_CACHE_DURATION && cachedSolUsdPrice !== 0) {
        console.log('[PRICE_CACHE] Using cached SOL/USD price.');
        return cachedSolUsdPrice;
    }
    try {
        console.log('[PRICE_CACHE] Fetching new SOL/USD price from CoinGecko...');
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        if (response.data && response.data.solana && response.data.solana.usd) {
            cachedSolUsdPrice = response.data.solana.usd;
            lastPriceFetchTime = Date.now();
            console.log(`[PRICE_CACHE] Fetched new SOL/USD price: ${cachedSolUsdPrice}`);
            return cachedSolUsdPrice;
        }
    } catch (error) {
        console.error('Error fetching SOL/USD price from CoinGecko:', error.message);
    }
    return 0;
}

// Function to get Jupiter Quote
async function getJupiterQuote(inputMint, outputMint, amount, slippage = 2, onlyDirectRoutes = false) { // Changed slippage to 2%
    try {
        // CORRECTED console.log syntax here - removed span tags
        console.log(`[JUPITER_QUOTE] Requesting quote: InputMint=${inputMint}, OutputMint=${outputMint}, Amount=${amount}, Slippage=${slippage}, OnlyDirectRoutes=${onlyDirectRoutes}`);
        const response = await axios.get('https://quote-api.jup.ag/v6/quote', {
            params: {
                inputMint,
                outputMint,
                amount,
                slippage,
                onlyDirectRoutes
            },
            // INCREASED TIMEOUT TO 20 SECONDS (20000 ms)
            timeout: 20000
        });
        return response.data;
    } catch (error) {
        // Check if it's a timeout error specifically
        if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
            console.error(`Error fetching Jupiter quote (TIMEOUT): timeout of ${error.config.timeout}ms exceeded`); // Improved message
        } else {
            console.error(`Error fetching Jupiter quote for ${inputMint} -> ${outputMint}:`, error.message);
        }
        return null;
    }
}

// Function to send BTC payment via Blockonomics
const sendBTC = async (btcAddress, usdAmount) => {
    if (!BLOCKONOMICS_API_KEY) {
        console.error("BLOCKONOMICS_API_KEY is not set. BTC payment skipped for", btcAddress);
        return { status: 'failed', message: 'Blockonomics API key missing.' };
    }
    try {
        const response = await axios.post('https://www.blockonomics.co/api/merchant_order', {
            addr: btcAddress,
            value: usdAmount * 100, // Blockonomics expects value in cents
        }, {
            headers: {
                'Authorization': `Bearer ${BLOCKONOMICS_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`BTC payment to ${btcAddress} successful. Blockonomics Order ID: ${response.data.order_id}`);
        return { status: 'success', orderId: response.data.order_id };
    } catch (error) {
        console.error(`Error sending BTC payment to ${btcAddress}:`, error.response ? error.response.data : error.message);
        return { status: 'failed', message: error.response ? error.response.data : error.message };
    }
};

// --- Main Profit Calculation and Sniping Logic ---
async function calculateRealProfit() {
    console.log('[BOT_CYCLE] Starting new profit calculation cycle...'); // Added logging
    if (!isRunning) { // Add this check to prevent execution if stopped mid-cycle
        console.log('[BOT_CYCLE] Bot is not running, skipping cycle.'); // Added logging
        return;
    }
    if (!internalWalletKeypair || !PLATFORM_SOLANA_PUBLIC_KEY) {
        console.error("Internal wallet or PLATFORM_SOLANA_ADDRESS not loaded. Cannot execute swaps.");
        return;
    }

    console.log('Searching for and executing profitable Jupiter swaps...');
    const solUsdPrice = await getSolUsdPrice();
    if (solUsdPrice === 0) {
        console.warn('Could not fetch SOL/USD price. Skipping swap evaluation for this cycle.');
        return;
    }

    // TEMPORARILY INCREASED FOR TESTING JUPITER QUOTES
    const inputAmountForTrade = 0.1; // Example: Try to trade with 0.1 SOL for debugging Jupiter
    // REMEMBER TO CHANGE THIS BACK TO 0.01 (or your desired amount) FOR PRODUCTION
    const inputLamportsForTrade = Math.round(inputAmountForTrade * LAMPORTS_PER_SOL);
    const inputMintTrade = 'So11111111111111111111111111111111111111112'; // SOL Mint address
    const outputMintTrade = 'EPjFWdd5AufqSSqeM2qN1xzybapT8G4wEGGkZwyTDt1v'; // USDC Mint address

    const quoteRes = await getJupiterQuote(inputMintTrade, outputMintTrade, inputLamportsForTrade);

    if (quoteRes && quoteRes.data && quoteRes.data.length > 0) {
        const bestRoute = quoteRes.data[0];

        if (bestRoute.priceImpactPct > MAX_PRICE_IMPACT_PCT) {
            console.log(`Skipping trade due to high price impact: ${bestRoute.priceImpactPct.toFixed(4)}`);
            return;
        }

        try {
            console.log(`[SWAP_EXEC] Attempting swap for route: ${bestRoute.id}`); // Added logging
            const swapRes = await axios.post('https://quote-api.jup.ag/v6/swap', {
                route: bestRoute,
                userPublicKey: PLATFORM_SOLANA_PUBLIC_KEY.toBase58(),
                wrapUnwrapSOL: true,
                feeAccount: null,
            }, {
                headers: { 'Content-Type': 'application/json' }
            });

            const { swapTransaction } = swapRes.data;

            const transaction = Transaction.from(Buffer.from(swapTransaction, 'base64'));
            transaction.sign(internalWalletKeypair);

            const txid = await connection.sendRawTransaction(transaction.serialize());
            console.log(`Swap transaction sent. TxID: ${txid}`);

            await connection.confirmTransaction(txid, 'confirmed');
            console.log(`Swap transaction confirmed: ${txid}`);

            const parsedTx = await connection.getParsedTransaction(txid, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            if (parsedTx && !parsedTx.meta.err) {
                let actualReceivedAmountUi = 0;
                let inputAmountUi = bestRoute.inAmount / (10 ** bestRoute.inToken.decimals);
                let feesPaidSol = parsedTx.meta.fee / LAMPORTS_PER_SOL;

                const postTokenBalances = parsedTx.meta.postTokenBalances;
                const preTokenBalances = parsedTx.meta.preTokenBalances;

                const outputMintPublicKey = new PublicKey(outputMintTrade);
                const internalWalletPublicKeyString = PLATFORM_SOLANA_PUBLIC_KEY.toBase58();

                const postBalanceEntry = postTokenBalances.find(bal =>
                    bal.owner === internalWalletPublicKeyString && bal.mint === outputMintPublicKey.toBase58()
                );
                const preBalanceEntry = preTokenBalances.find(bal =>
                    bal.owner === internalWalletPublicKeyString && bal.mint === outputMintPublicKey.toBase58()
                );

                if (postBalanceEntry && preBalanceEntry) {
                    const postAmount = postBalanceEntry.uiTokenAmount.uiAmount;
                    const preAmount = preBalanceEntry.uiTokenAmount.uiAmount;
                    actualReceivedAmountUi = postAmount - preAmount;
                } else {
                    console.warn(`Could not precisely parse actual output token amount for ${outputMintTrade}. Using bestRoute.outAmount as fallback.`);
                    actualReceivedAmountUi = bestRoute.outAmount / (10 ** bestRoute.outToken.decimals);
                }

                let actualOutputSOL = 0;
                if (outputMintTrade === 'So11111111111111111111111111111111111111112') {
                    actualOutputSOL = actualReceivedAmountUi;
                } else {
                    console.log(`Traded ${inputAmountUi.toFixed(6)} ${bestRoute.inToken.symbol} for ${actualReceivedAmountUi.toFixed(6)} ${bestRoute.outToken.symbol}`);
                    actualOutputSOL = (actualReceivedAmountUi * solUsdPrice) / solUsdPrice; // This line seems redundant/incorrect if actualReceivedAmountUi is already in USD or needs conversion
                }

                const profitInSol = actualOutputSOL - inputAmountForTrade;
                const finalNetUSDProfit = (profitInSol * solUsdPrice) - feesPaidSol * solUsdPrice;

                if (finalNetUSDProfit >= MIN_PROFIT_THRESHOLD_USD) {
                    profitUSD += finalNetUSDProfit;
                    console.log(`✅ Realized PROFIT: $${finalNetUSDProfit.toFixed(2)} USD from TxID: ${txid}`);
                    console.log(`Current Total Profit: $${profitUSD.toFixed(2)} USD.`);
                } else {
                    console.log(`❌ Trade resulted in low/negative profit ($${finalNetUSDProfit.toFixed(2)} USD). TxID: ${txid}`);
                }

            } else {
                console.error(`Transaction ${txid} failed or could not be parsed:`, parsedTx.meta.err);
            }

        } catch (swapError) {
            console.error('Error during Jupiter swap execution or confirmation:', swapError);
        }
    } else {
        console.log('No profitable Jupiter route found for current trade check.');
    }
}


// --- API Endpoints ---

app.post('/start', async (req, res) => {
    console.log("[API /start] Received /start request."); // ADDED LOG
    if (!isRunning) {
        isRunning = true;
        startTime = Date.now();
        console.log("[API /start] Setting isRunning to TRUE. Bot startup sequence initiated."); // ADDED LOG

        if (!PLATFORM_SOLANA_PUBLIC_KEY) {
            isRunning = false;
            console.error("[API /start] ERROR: PLATFORM_SOLANA_ADDRESS environment variable not set. Cannot start."); // ADDED LOG
            return res.status(500).json({ message: "PLATFORM_SOLANA_ADDRESS environment variable not set." });
        }
        try {
            console.log("[API /start] Attempting to load SOLANA_PRIVATE_KEY_BASE58..."); // ADDED LOG
            const privateKeyBase58 = process.env.SOLANA_PRIVATE_KEY_BASE58;
            if (!privateKeyBase58) {
                throw new Error("SOLANA_PRIVATE_KEY_BASE58 environment variable not set. Cannot start sniping.");
            }
            internalWalletKeypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
            console.log(`[API /start] Internal wallet loaded successfully: ${internalWalletKeypair.publicKey.toBase58()}`); // ADDED LOG
        } catch (error) {
            console.error("[API /start] ERROR: Failed to load internal wallet:", error.message); // ADDED LOG
            isRunning = false;
            return res.status(500).json({ message: `Failed to start: ${error.message}` });
        }

        if (transactionMonitorInterval) clearInterval(transactionMonitorInterval);
        // Changed interval to 60 seconds (1 minute) to reduce API calls
        transactionMonitorInterval = setInterval(calculateRealProfit, 60 * 1000); // MODIFIED INTERVAL
        console.log("[API /start] Sniping process interval started. Next cycle in 60 seconds."); // ADDED LOG
        res.json({ message: "Sniping started. Monitoring for profitable trades and executing swaps." });
    } else {
        console.log("[API /start] Sniping already running. Ignoring request."); // ADDED LOG
        res.json({ message: "Already running." });
    }
});

app.post('/stop', (req, res) => {
    isRunning = false;
    if (transactionMonitorInterval) clearInterval(transactionMonitorInterval);
    console.log("Sniping stopped.");
    res.json({ message: "Sniping stopped." });
});

app.get('/status', async (req, res) => {
    const uptimeHours = isRunning ? ((Date.now() - startTime) / 3600000).toFixed(2) : 0;
    const solUsd = await getSolUsdPrice(); // This will use the cached price or fetch new
    res.json({
        running: isRunning,
        profitUSD: profitUSD.toFixed(2),
        uptimeHours,
        solUsdPrice: solUsd // CORRECTED: Added 'Usd' to 'sol'
    });
});

app.post('/withdraw', async (req, res) => {
    const { userWalletAddress } = req.body;
    if (!userWalletAddress) {
        return res.status(400).json({ status: 'failed', message: 'User wallet address not provided for withdrawal.' });
    }

    const total = profitUSD;
    if (total <= 0) {
        return res.json({ status: 'failed', message: 'No profit to withdraw.' });
    }

    if (!internalWalletKeypair) {
          try {
            const privateKeyBase58 = process.env.SOLANA_PRIVATE_KEY_BASE58;
            if (!privateKeyBase58) {
                throw new Error("SOLANA_PRIVATE_KEY_BASE58 environment variable not set.");
            }
            internalWalletKeypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
            console.log(`Internal wallet loaded for withdrawal: ${internalWalletKeypair.publicKey.toBase58()}`);
        } catch (error) {
            console.error("Failed to load internal wallet for withdrawal:", error.message);
            return res.status(500).json({ status: 'failed', message: `Withdrawal failed: ${error.message}. Ensure SOLANA_PRIVATE_KEY_BASE58 is set correctly.` });
        }
    }


    const userShareUSD = total * 0.8;
    const devShareUSD = total * 0.1;

    try {
        const solUsdPrice = await getSolUsdPrice();
        if (solUsdPrice === 0) {
            throw new Error("Could not fetch current SOL/USD price for withdrawal.");
        }

        const userShareSOL = userShareUSD / solUsdPrice;
        const userPublicKey = new PublicKey(userWalletAddress);

        let userTxSignature = null;
        try {
            const userTransaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: internalWalletKeypair.publicKey,
                    toPubkey: userPublicKey,
                    lamports: Math.round(userShareSOL * LAMPORTS_PER_SOL),
                })
            );
            userTxSignature = await sendAndConfirmTransaction(connection, userTransaction, [internalWalletKeypair]);
            console.log(`Sent ${userShareSOL.toFixed(4)} SOL to user: ${userWalletAddress}. Tx: ${userTxSignature}`);
        } catch (solError) {
            console.error('Error sending SOL to user:', solError);
            return res.status(500).json({ status: 'failed', message: `Failed to send SOL to user: ${solError.message}` });
        }

        let btcPaymentResults = [];
        for (const devBtcAddress of DEV_BTC_ADDRESSES) {
            const result = await sendBTC(devBtcAddress, devShareUSD);
            btcPaymentResults.push({ address: devBtcAddress, ...result });
        }

        let btcPaymentStatus = 'BTC payments initiated.';
        if (btcPaymentResults.some(r => r.status === 'failed')) {
            btcPaymentStatus = 'Warning: BTC payments failed for one or more developers. Check logs.';
        } else {
            btcPaymentStatus = 'All BTC payments successful.';
        }

        profitUSD = 0;
        res.json({
            status: 'success',
            sentToUserInSOL: userShareSOL.toFixed(4),
            message: `Withdrawal complete. User received ${userShareSOL.toFixed(4)} SOL. ${btcPaymentStatus}`,
            userSolanaTx: userTxSignature,
            devBtcPaymentResults: btcPaymentResults
        });

    } catch (error) {
        console.error('Withdrawal error:', error);
        res.status(500).json({ status: 'failed', message: `Withdrawal failed: ${error.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
    if (!process.env.SOLANA_PRIVATE_KEY_BASE58) {
        console.warn("WARNING: SOLANA_PRIVATE_KEY_BASE58 is not set. Sniping and withdrawals will fail.");
    }
    if (!process.env.BLOCKONOMICS_API_KEY) {
        console.warn("WARNING: BLOCKONOMICS_API_KEY is not set. BTC payments will fail.");
    }
    if (!PLATFORM_SOLANA_ADDRESS) {
        console.warn("WARNING: PLATFORM_SOLANA_ADDRESS is not set. Sniping will not properly identify your wallet.");
    }
});