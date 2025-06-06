const fs = require("fs");
const path = require("path");
const bs58 = require("bs58");
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
require("dotenv\config");

const connection = new Connection(process.env.SOLANA_RPC_URL);
const protocolPath = path.resolve(__dirname, process.env.PROTOCOL_JSON_PATH);
const logPath = path.resolve(__dirname, process.env.PROTOCOL_LOG_PATH);

const botWallet = Keypair.fromSecretKey(bs58.decode(process.env.BOT_WALLET_SECRET_KEY_BASE58));
const sniperWallet = new PublicKey(process.env.SNIPER_WALLET_ADDRESS);
const btcUser = process.env.USER_BTC_ADDRESS;
const btcReserve = process.env.RESERVE_BTC_ADDRESS;

async function getMonthNumber() {
  const now = new Date();
  return now.getUTCMonth() + 1; // 1-indexed
}

function loadProtocol() {
  const data = fs.readFileSync(protocolPath);
  return JSON.parse(data);
}

function loadCurrentMonth(protocol, month) {
  return protocol.find(p => p.month === month) || protocol[protocol.length - 1];
}

async function sendSOL(from, to, amountSOL) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: new PublicKey(to),
      lamports: amountSOL * LAMPORTS_PER_SOL,
    })
  );
  return await sendAndConfirmTransaction(connection, tx, [from]);
}

async function sendBTC(toAddress, amountUSD, tag) {
  // Simulated BTC payment logic — replace with Blockonomics or API logic
  console.log(`Sending $${amountUSD} BTC to ${tag} → ${toAddress}`);
  return `mock_btc_tx_${tag}_${Date.now()}`;
}

async function executeMonth() {
  const protocol = loadProtocol();
  const month = await getMonthNumber();
  const current = loadCurrentMonth(protocol, month);

  const { profit, reinvest, take_home } = current;

  console.log("Executing Month", month, current);

  const reinvestTx = await sendSOL(botWallet, sniperWallet.toBase58(), reinvest);

  const btc80 = take_home * 0.8;
  const btc20 = take_home * 0.2;
  const btc80tx = await sendBTC(btcUser, btc80, "btc_80");
  const btc20tx = await sendBTC(btcReserve, btc20, "btc_20");

  const log = {
    month,
    profit,
    reinvest,
    take_home,
    date: new Date().toISOString(),
    txs: {
      sol: reinvestTx,
      btc_80: btc80tx,
      btc_20: btc20tx
    }
  };

  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  console.log("Execution complete:", log);
}

module.exports = executeMonth;
