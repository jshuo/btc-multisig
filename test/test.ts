// make env configurable in node.js
process.env = {};

import * as lib from "../src/index";
import { config, CoinType } from "../src/index";
import * as secp256k1 from "secp256k1";
import * as assert from 'assert';
import { db } from "../src/utils";
import { TransactionStatus } from "../src/interface";
import { getByteCount } from "../src/getByteCount";


// Set network to testnet for this test case
config.network = CoinType.TESTNET;
config.rpcUrl = "https://bitcoin-testnet-rpc.publicnode.com";
config.blockbookUrl = "https://tbtc1.trezor.io";

describe("Transaction Lifecycle Test Suite (Testnet)", () => {
	let testWalletId: string;
	let testWalletAddress: string;
	let participantPublicKeys: string[];
	let transactionId: string | undefined; // To share transactionId between tests
	let feeRate: number;
	let txHash: string;
	const recipientAddress = "tb1qfksct6cu46hvm6kgqqyeg244d9vcvkwfstg5ahwlzzq0sgf6qfzqh7ld3e"; // Example testnet address
	const amount = 500; // in satoshis
	const privKey = [
		Buffer.from("mock_privatekey1", "hex"),
		Buffer.from("mock_privatekey2", "hex"),
		Buffer.from("mock_privatekey3", "hex"),
	];

	// Setup a test wallet before running tests
	before(async () => { // Changed beforeAll to before for Mocha
		// Clean up database before test suite starts
		for await (const [key] of db.iterator()) {
			await db.del(key);
		}

		const participants = [
			{ publicKey: Buffer.from(secp256k1.publicKeyCreate(privKey[0])).toString("hex"), userId: "user1" }, // Example public keys - replace with testnet keys if needed
			{ publicKey: Buffer.from(secp256k1.publicKeyCreate(privKey[1])).toString("hex"), userId: "user2" },
			{ publicKey: Buffer.from(secp256k1.publicKeyCreate(privKey[2])).toString("hex"), userId: "user3" },
		];
		const createWalletResult = await lib.createMultisigWallet({
			m: 2,
			n: 3,
			name: "Test Testnet Wallet",
			participants: participants,
		});
		testWalletId = createWalletResult.walletId;
		testWalletAddress = createWalletResult.address;
		participantPublicKeys = participants.map(p => p.publicKey);

		console.log(`Test Wallet Address (Testnet):\n${testWalletAddress}\n`);

		// Wait a bit to ensure wallet is created in DB (in real test, you might need to wait for funding too)
		await new Promise(resolve => setTimeout(resolve, 500));
	});

	it("should fetch fee rate recommendations and have a normal fee rate greater than zero", async function () {
		this.timeout(30000);
		const feeRateRecommendations = await lib.getFeeRateRecommendations();
		assert.ok(feeRateRecommendations, "Failed to get fee rate recommendations");
		assert.ok(typeof feeRateRecommendations === 'object', "feeRateRecommendations should be an object");
		assert.ok(feeRateRecommendations.normal !== undefined, "feeRateRecommendations should have a 'normal' property");
		assert.strictEqual(typeof feeRateRecommendations.normal, 'number', "feeRateRecommendations.normal should be a number");
		assert.ok(feeRateRecommendations.normal > 0, "feeRateRecommendations.normal should be greater than zero");

		feeRate = feeRateRecommendations.normal;
		console.log(`Network fee rate: ${feeRate}`);
	});

	it("should have a balance greater than zero", async function () {
		this.timeout(30000);
		const balanceResult = await lib.getWalletBalance(testWalletId);
		assert.ok(balanceResult, "Failed to get wallet balance");
		assert.ok(balanceResult.confirmedBalance > 0, "Wallet balance should be greater than zero");
	});

	it("should estimate transaction fee", async function () {
		this.timeout(30000);
		const vSize = await lib.estimateVirtualSize(testWalletId, recipientAddress);
		assert.ok(vSize > 0, "Failed to estimate transaction virtual size");

		const transactionFee = vSize * feeRate;
		assert.ok(transactionFee > 0, "Failed to estimate transaction fee");

		console.log(`Estimated transaction fee: ${transactionFee}`);
	});

	it("should initiate a transaction on testnet successfully", async function () {
		this.timeout(30000); // Mocha way to set timeout

		const transaction = await lib.initiateTransaction(testWalletId, {
			recipientAddress,
			amount,
			feeRate,
			note: "Testnet transaction initiation test",
		});
		assert.ok(transaction, "Transaction initiation failed");
		assert.strictEqual(transaction.status, TransactionStatus.pending, "Transaction status should be pending after initiation");
		transactionId = transaction.transactionId; // Store transactionId for subsequent tests
	});

	it("should get unsigned transaction data successfully", async function () {
		this.timeout(30000);
		assert.ok(transactionId, "transactionId should be defined from previous test");
		const unsignedTxData = await lib.getUnsignedTransaction(transactionId!);
		assert.ok(unsignedTxData, "Failed to get unsigned transaction data");
		assert.strictEqual(unsignedTxData.transactionId, transactionId, "Transaction IDs should match");
		assert.ok(unsignedTxData.unsignedTransactions.length > 0, "Unsigned transactions array should not be empty");
	});

	it("should get pending transactions and find the initiated transaction before signing", async function () {
		this.timeout(30000);
		const pendingTransactionsResult = await lib.getPendingTransactions(testWalletId);
		assert.ok(pendingTransactionsResult, "Failed to get pending transactions");
		assert.ok(Array.isArray(pendingTransactionsResult.pendingTransactions), "Pending transactions result should contain a pendingTransactions array");
		assert.ok(pendingTransactionsResult.pendingTransactions.length > 0, "Pending transactions should be found");

		const foundPendingTx = pendingTransactionsResult.pendingTransactions.find(tx => tx.transactionId === transactionId);
		assert.ok(foundPendingTx, "Initiated pending transaction should be in the list of pending transactions");
		assert.strictEqual(foundPendingTx.status, TransactionStatus.pending, "The found pending transaction should have 'pending' status");
		assert.strictEqual(foundPendingTx.transactionId, transactionId, "Transaction ID of found pending transaction should match");
	});

	it("should submit signatures from participants and reach allsigned status", async function () {
		this.timeout(30000);
		assert.ok(transactionId, "transactionId should be defined from previous test");
		const { unsignedTransactions } = await lib.getUnsignedTransaction(transactionId!);

		// Submit signatures from participant 3
		const signatures1: Array<string> = [];
		for (const unsignedTx of unsignedTransactions) {
			const hash = Buffer.from(unsignedTx, "hex");
			const { signature } = secp256k1.ecdsaSign(hash, privKey[2]);
			signatures1.push(Buffer.from(signature).toString("hex"));
		}
		const submitSigResult1 = await lib.submitSignature(transactionId!, {
			publicKey: participantPublicKeys[2],
			signatures: signatures1,
		});
		assert.ok(submitSigResult1, "Submitting signature from participant 3 failed");
		assert.strictEqual(submitSigResult1.signaturesReceived, 1, "Signatures received should be 1 after first signature");
		assert.strictEqual(submitSigResult1.status, TransactionStatus.pending, "Transaction status should still be pending after 1 signature");

		// Submit signatures from participant 2
		const signatures2: Array<string> = [];
		for (const unsignedTx of unsignedTransactions) {
			const hash = Buffer.from(unsignedTx, "hex");
			const { signature } = secp256k1.ecdsaSign(hash, privKey[1]);
			signatures2.push(Buffer.from(signature).toString("hex"));
		}
		const submitSigResult2 = await lib.submitSignature(transactionId!, {
			publicKey: participantPublicKeys[1],
			signatures: signatures2,
		});
		assert.ok(submitSigResult2, "Submitting signature from participant 2 failed");
		assert.strictEqual(submitSigResult2.signaturesReceived, 2, "Signatures received should be 2 after second signature");
		assert.strictEqual(submitSigResult2.status, TransactionStatus.allsigned, "Transaction status should be finished_signatures after 2 signatures");
		
		const updatedTransaction = await db.get(`tx:${transactionId}`);
		assert.ok(updatedTransaction.signedTransaction, "signedTransaction should be available after enough signatures");
	});

	it("should broadcast the signed transaction successfully", async function () {
		this.timeout(30000);
		assert.ok(transactionId, "transactionId should be defined from previous test");
		const broadcastResult = await lib.broadcastTransaction(transactionId!);
		assert.ok(broadcastResult, "Transaction broadcast failed");
		assert.ok(broadcastResult.txHash, "Broadcast result should contain a txHash");
		assert.strictEqual(broadcastResult.status, TransactionStatus.broadcasted, "Transaction status should be broadcasted after broadcasting");

		txHash = broadcastResult.txHash;
		console.log(`Broadcasted Transaction Hash (Testnet):\n${broadcastResult.txHash}\n`);
	});

	it("should get transaction status as broadcasted", async function () {
		this.timeout(30000);
		assert.ok(transactionId, "transactionId should be defined from previous test");
		const statusResult = await lib.getTransactionStatus(transactionId!);
		assert.ok(statusResult, "Failed to get transaction status");
		assert.strictEqual(statusResult.status, TransactionStatus.broadcasted, "Transaction status should be broadcasted");
		assert.ok(statusResult.txHash, "Transaction status result should contain txHash");
	});

	it("should get pending transactions and find none after broadcast", async function () {
		this.timeout(30000);
		const pendingResult = await lib.getPendingTransactions(testWalletId);
		assert.ok(pendingResult, "Failed to get pending transactions");
		assert.ok(Array.isArray(pendingResult.pendingTransactions), "Pending transactions result should contain a pendingTransactions array");
		assert.strictEqual(pendingResult.pendingTransactions.length, 0, "No pending transactions should be found after broadcasting");
	});

	it("should get transaction history and find the broadcasted transaction", async function () {
		this.timeout(30000);

		// wait for processing
		await new Promise(resolve => setTimeout(resolve, 7000));

		const historyResult = await lib.getTransactionHistory(testWalletId);
		assert.ok(historyResult, "Failed to get transaction history");
		assert.ok(Array.isArray(historyResult.transactions), "Transaction history should contain a transactions array");
		const transactionInHistory = historyResult.transactions.find(tx => tx.txHash === txHash);
		assert.ok(transactionInHistory, "Broadcasted transaction should be found in history");

		console.log(`Transaction History for Wallet ${testWalletId}:\n`, historyResult.transactions);
	});

	it("should perform health check successfully", async function () {
		this.timeout(30000);
		const healthCheckResult = await lib.healthCheck();
		assert.ok(healthCheckResult, "Health check failed");
		assert.strictEqual(healthCheckResult.status, "ok", "Health check status should be ok");
		assert.ok(healthCheckResult.blocks > 0, "Health check should return block height");
	});
});
