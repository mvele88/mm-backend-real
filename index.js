const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const { createJupiterApiClient } = require('@jup-ag/api');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require('@solana/spl-token');

// --- Express App Setup ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Solana & Bot Configuration from Environment Variables ---
// Default to mainnet-beta if not set, or use your specific QuickNode URL
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

const PLATFORM_SOLANA_ADDRESS = process.env.PLATFORM_SOLANA_ADDRESS;
const SOLANA_PRIVATE_KEY_BASE58 = process.env.SOLANA_PRIVATE_KEY_BASE58;

let internalWalletKeypair;
let PLATFORM_SOLANA_PUBLIC_KEY;

// Initialize internal wallet from private key
try {
    if (!SOLANA_PRIVATE_KEY_BASE58) {
        throw new Error("SOLANA_PRIVATE_KEY_BASE58 environment variable is not set.");
    }
    const decodedPrivateKey = bs58.decode(SOLANA_PRIVATE_KEY_BASE58);
    internalWalletKeypair = Keypair.fromSecretKey(decodedPrivateKey);
    console.log("Internal wallet loaded:", internalWalletKeypair.publicKey.toBase58());
} catch (error) {
    console.error("Failed to load internal wallet from SOLANA_PRIVATE_KEY_BASE58. Please check your .env file:", error.message);
    // Exit if the wallet cannot be loaded, as it's critical for bot operation
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
    // Exit if the platform address cannot be loaded
    process.exit(1);
}


// --- Jupiter API Configuration ---
const JUPITER_API_ENDPOINT = 'https://quote-api.jup.ag/v6'; // Public Jupiter Aggregator API endpoint
const JUPITER_PRICE_API_ENDPOINT = 'https://price.jup.ag/v4/price'; // Public Jupiter Price API endpoint
const jupiterApi = createJupiterApiClient({
    basePath: JUPITER_API_ENDPOINT,
});

// --- Common Token Mint Addresses ---
const USDC_MINT_ADDRESS = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTD1v'); // USDC
const USDT_MINT_ADDRESS = new PublicKey('Es9bitx6Qe2JsZK193W1kydBvU6nZBX6n65g7cK8D8D'); // USDT
const SOL_MINT_ADDRESS = new PublicKey('So11111111111111111111111111111111111111112'); // SOL (native mint)

// --- Bot Specific Environment Variables (with defaults) ---
const SOL_REINVESTMENT_THRESHOLD_SOL = parseFloat(process.env.SOL_REINVESTMENT_THRESHOLD_SOL) || 0.5; // SOL balance below which replenishment is triggered
const SOL_REINVESTMENT_TOPUP_AMOUNT_USD = parseFloat(process.env.SOL_REINVESTMENT_TOPUP_AMOUNT_USD) || 20; // Amount of stablecoin/X-coin to swap to SOL
const MIN_SWAP_VALUE_USD = parseFloat(process.env.MIN_SWAP_VALUE_USD) || 1; // Minimum USD value of a token to consider for swap

// Optional: For future profit/withdrawal logic (based on previous discussions)
const AUTO_PAYOUT_USD_AMOUNT = parseFloat(process.env.AUTO_PAYOUT_USD_AMOUNT) || 50;
const BTC_WITHDRAWAL_FEE_BUFFER_USD = parseFloat(process.env.BTC_WITHDRAWAL_FEE_BUFFER_USD) || 20;

// --- Bot State Variables ---
let botRunning = false;
let botStartTime = null;
let replenishIntervalId = null; // To store the interval ID for clearing on stop

// --- Helper Functions ---

/**
 * Sends and confirms a Solana transaction.
 * @param {Connection} connection The Solana connection object.
 * @param {VersionedTransaction} transaction The transaction to send.
 * @param {Array<Keypair>} signers An array of Keypairs to sign the transaction.
 * @returns {Promise<string>} The transaction signature.
 */
async function sendAndConfirmTransaction(connection, transaction, signers) {
    try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        transaction.setLatestBlockhash({ blockhash, lastValidBlockHeight });

        transaction.sign(signers);

        const rawTransaction = transaction.serialize();
        const signature = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true, // Set to false in production for stricter checks
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
 * Fetches the current USD price of a given token mint.
 * @param {string} mintAddress The Base58 string of the token's mint address.
 * @returns {Promise<number>} The price of the token in USD, or 0 if not found/error.
 */
async function getTokenPriceInUSD(mintAddress) {
    try {
        const response = await axios.get(`${JUPITER_PRICE_API_ENDPOINT}?ids=${mintAddress}`);
        if (response.data && response.data.data && response.data.data[mintAddress]) {
            return response.data.data[mintAddress].price;
        }
        return 0;
    } catch (error) {
        console.error(`Error fetching price for ${mintAddress}:`, error.message);
        return 0;
    }
}

// --- Core Bot Logic: SOL Replenishment ---

/**
 * Checks the wallet's SOL balance and replenishes it by swapping other tokens if below threshold.
 * @param {Connection} connection The Solana connection object.
 * @param {Keypair} walletKeypair The bot's internal wallet keypair.
 * @param {number} solThresholdLamports The SOL balance threshold in lamports.
 * @param {number} swapAmountUsd The USD value of tokens to swap for SOL.
 * @returns {Promise<boolean>} True if replenishment was attempted/successful, false otherwise.
 */
async function replenishSolBalance(connection, walletKeypair, solThresholdLamports, swapAmountUsd) {
    try {
        const currentSolBalanceLamports = await connection.getBalance(walletKeypair.publicKey);
        console.log(`Current SOL Balance: ${currentSolBalanceLamports / LAMPORTS_PER_SOL} SOL`);

        if (currentSolBalanceLamports < solThresholdLamports) {
            console.log(`SOL balance (${currentSolBalanceLamports / LAMPORTS_PER_SOL} SOL) is below threshold (${solThresholdLamports / LAMPORTS_PER_SOL} SOL). Initiating SOL replenishment.`);

            // Get all SPL token accounts for the wallet
            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
                walletKeypair.publicKey, {
                    programId: TOKEN_PROGRAM_ID
                }
            );

            let potentialSwapSources = [];

            // Iterate through accounts, get prices, and filter for usable tokens
            for (const account of tokenAccounts.value) {
                const mintAddress = account.account.data.parsed.info.mint;
                const uiAmount = account.account.data.parsed.info.tokenAmount.uiAmount;
                const decimals = account.account.data.parsed.info.tokenAmount.decimals;

                // Skip SOL's wrapped token account if present, and any tokens with 0 balance
                if (uiAmount > 0 && mintAddress !== SOL_MINT_ADDRESS.toBase58()) {
                    const price = await getTokenPriceInUSD(mintAddress);
                    const usdValue = uiAmount * price;

                    // Only consider tokens that have enough value to potentially cover the swap
                    if (usdValue >= MIN_SWAP_VALUE_USD) {
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

            // Sort potential swap sources: Stablecoins first, then by highest USD value
            potentialSwapSources.sort((a, b) => {
                if (a.isStablecoin && !b.isStablecoin) return -1; // Stablecoins before others
                if (!a.isStablecoin && b.isStablecoin) return 1; // Others after stablecoins
                return b.usdValue - a.usdValue; // Then by USD value descending
            });

            if (potentialSwapSources.length === 0) {
                console.warn("No suitable tokens found in wallet to swap for SOL replenishment.");
                return false;
            }

            let selectedSource = null;
            let inputTokenAmountRaw = 0; // Amount in raw token lamports
            let inputMint = null;

            // Find the best single source to cover the required swapAmountUsd
            for (const source of potentialSwapSources) {
                if (source.usdValue >= swapAmountUsd) {
                    selectedSource = source;
                    // Calculate raw amount needed for `swapAmountUsd` based on token's price and decimals
                    inputTokenAmountRaw = Math.floor((swapAmountUsd / source.price) * (10 ** source.decimals));
                    inputMint = source.mint;
                    console.log(`Using ~${(inputTokenAmountRaw / (10 ** source.decimals)).toFixed(4)} ${selectedSource.mint.toBase58().substring(0, 5)}... (worth ~$${swapAmountUsd.toFixed(2)}) for SOL replenishment.`);
                    break; // Found enough from one source, stop searching
                } else {
                    // If no single source fully covers, consider using the largest available one if it's the only option
                    // For simplicity, we'll try the largest available token as the source, even if it doesn't cover fully.
                    // More complex logic might combine multiple tokens.
                    selectedSource = source;
                    inputTokenAmountRaw = Math.floor(source.uiAmount * (10 ** source.decimals)); // Use all of this token
                    inputMint = source.mint;
                    console.warn(`Insufficient single source to cover full $${swapAmountUsd.toFixed(2)} replenishment. Using all of ~${(source.uiAmount).toFixed(4)} ${selectedSource.mint.toBase58().substring(0,5)}... (worth ~$${source.usdValue.toFixed(2)}) for SOL replenishment.`);
                    break; // Use the largest available token as the input source
                }
            }

            if (!selectedSource || inputTokenAmountRaw === 0) {
                console.warn("Could not find a suitable token source with enough value for SOL replenishment.");
                return false;
            }

            // Get quote from Jupiter
            const quoteResponse = await jupiterApi.quoteGet({
                inputMint: inputMint.toBase58(),
                outputMint: SOL_MINT_ADDRESS.toBase58(),
                amount: inputTokenAmountRaw,
                slippageBps: 100 // 1% slippage tolerance
            });

            if (!quoteResponse) {
                console.error("Failed to get swap quote from Jupiter for SOL replenishment.");
                return false;
            }

            console.log(`Jupiter Quote: ${quoteResponse.outAmount / LAMPORTS_PER_SOL} SOL for ${inputTokenAmountRaw / (10 ** selectedSource.decimals)} ${selectedSource.mint.toBase58().substring(0, 5)}...`);

            // Get swap instructions
            const swapResponse = await jupiterApi.swapPost({
                swapRequest: {
                    quoteResponse,
                    userPublicKey: walletKeypair.publicKey.toBase58(),
                    wrapUnwrapSOL: true, // Automatically wrap/unwrap SOL if necessary
                },
            });

            const { swapTransaction } = swapResponse;

            if (!swapTransaction) {
                console.error("Failed to get swap transaction from Jupiter.");
                return false;
            }

            // Deserialize the transaction received from Jupiter
            const transactionBuffer = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(transactionBuffer);

            // Send and confirm the transaction
            const txid = await sendAndConfirmTransaction(connection, transaction, [walletKeypair]);

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

// --- Bot Control Functions ---

/**
 * Starts the main bot process, including periodic SOL replenishment checks.
 */
function startBotProcess() {
    console.log("M&M AI Platform core process starting...");
    botStartTime = new Date();

    // Set up periodic SOL replenishment check
    const SOL_THRESHOLD_LAMPORTS = SOL_REINVESTMENT_THRESHOLD_SOL * LAMPORTS_PER_SOL;
    replenishIntervalId = setInterval(async () => {
        if (botRunning) { // Only run if the bot is actually marked as running
            try {
                await replenishSolBalance(
                    connection,
                    internalWalletKeypair,
                    SOL_THRESHOLD_LAMPORTS,
                    SOL_REINVESTMENT_TOPUP_AMOUNT_USD
                );
            } catch (error) {
                console.error("Error in scheduled SOL replenishment:", error);
            }
        } else {
            // If botRunning is false, clear the interval to stop checks
            clearInterval(replenishIntervalId);
            replenishIntervalId = null;
            console.log("SOL replenishment monitor stopped due to bot state.");
        }
    }, 5 * 60 * 1000); // Check every 5 minutes (adjust as needed for your operations)

    // TODO: Integrate your actual trading/sniping logic here.
    // This part would typically involve listeners, market analysis, trade execution, etc.
    console.log("SOL replenishment monitor started. Integrate your main trading/sniping logic here.");
}

/**
 * Stops the main bot process and clears any active intervals.
 */
function stopBotProcess() {
    console.log("M&M AI Platform core process stopping...");
    if (replenishIntervalId) {
        clearInterval(replenishIntervalId);
        replenishIntervalId = null;
        console.log("SOL replenishment monitor stopped.");
    }
    botStartTime = null; // Reset start time
    // TODO: Add logic here to gracefully stop any other trading/sniping processes
}


// --- API Endpoints ---

// Root endpoint: Basic confirmation that the API is running
app.get('/', (req, res) => {
    res.json({ message: "M&M Backend API is running! Access specific endpoints like /status or /start (POST)." });
});

// Status endpoint: Provides current bot state and wallet information
app.get('/status', async (req, res) => {
    let currentSolBalance = "0.00000";
    let solUsdPrice = 0; // Default to 0
    let usdcBalance = "0.00";
    let usdtBalance = "0.00";

    try {
        solUsdPrice = await getTokenPriceInUSD(SOL_MINT_ADDRESS.toBase58());
        if (solUsdPrice === 0) console.warn("Could not fetch SOL USD price.");
    } catch (error) {
        console.error("Error fetching SOL price for status:", error);
    }

    try {
        const balance = await connection.getBalance(internalWalletKeypair.publicKey);
        currentSolBalance = (balance / LAMPORTS_PER_SOL).toFixed(5);
    } catch (error) {
        console.error("Error fetching current SOL balance for status:", error);
    }

    try {
        // Fetch USDC balance
        const usdcAccount = getAssociatedTokenAddressSync(USDC_MINT_ADDRESS, internalWalletKeypair.publicKey, true);
        const usdcTokenBalance = await connection.getTokenAccountBalance(usdcAccount);
        usdcBalance = usdcTokenBalance.value.uiAmount.toFixed(2);
    } catch (error) {
        // If the ATA doesn't exist or other error, balance is effectively 0
        // console.warn("Could not get USDC balance (ATA might not exist):", error.message);
    }

    try {
        // Fetch USDT balance
        const usdtAccount = getAssociatedTokenAddressSync(USDT_MINT_ADDRESS, internalWalletKeypair.publicKey, true);
        const usdtTokenBalance = await connection.getTokenAccountBalance(usdtAccount);
        usdtBalance = usdtTokenBalance.value.uiAmount.toFixed(2);
    } catch (error) {
        // If the ATA doesn't exist or other error, balance is effectively 0
        // console.warn("Could not get USDT balance (ATA might not exist):", error.message);
    }


    const uptimeHours = botStartTime ? ((new Date() - botStartTime) / (1000 * 60 * 60)).toFixed(2) : "0.00";

    res.json({
        running: botRunning,
        uptimeHours: uptimeHours,
        profitUSD: "0.00", // Placeholder: You will need to implement actual profit tracking
        solUsdPrice: parseFloat(solUsdPrice.toFixed(2)),
        currentSolBalance: currentSolBalance,
        stablecoinBalances: {
            USDC: usdcBalance,
            USDT: usdtBalance
        },
        solReinvestmentThreshold: SOL_REINVESTMENT_THRESHOLD_SOL,
        btcWithdrawalFeeBuffer: BTC_WITHDRAWAL_FEE_BUFFER_USD,
        autoPayoutAmount: AUTO_PAYOUT_USD_AMOUNT
    });
});

// Start endpoint: Initiates the bot's core process
app.post('/start', (req, res) => {
    if (botRunning) {
        return res.status(400).json({ message: "Bot is already running." });
    }
    botRunning = true;
    startBotProcess(); // Call the function to start monitoring and trading
    res.json({ message: "M&M AI Platform started successfully!" });
});

// Stop endpoint: Halts the bot's core process
app.post('/stop', (req, res) => {
    if (!botRunning) {
        return res.status(400).json({ message: "Bot is not running." });
    }
    botRunning = false;
    stopBotProcess(); // Call the function to stop monitoring and trading
    res.json({ message: "M&M AI Platform stopped successfully!" });
});

// --- Server Start ---
app.listen(PORT, () => {
    console.log(`M&M Backend API running on port ${PORT}`);
    // Optional: Auto-start bot on deployment if desired (uncomment and set env var)
    // if (process.env.AUTO_START_BOT === 'true') {
    //     botRunning = true;
    //     startBotProcess();
    //     console.log("Bot auto-started due to AUTO_START_BOT environment variable.");
    // }
});