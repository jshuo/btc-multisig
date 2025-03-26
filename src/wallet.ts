import { SecuxPsbt } from "@secux/app-btc/lib/psbt";
import { HexString, Transaction, TransactionStatus, Wallet } from "./interface";
import { db, dbGet, generateWalletId, config } from "./utils";
import * as utils from "./utils";

export async function createMultisigWallet(params: {
	m: number,
	n: number,
	name?: string,
	participants: Array<{ publicKey: HexString, userId?: string }>
}) {
	const { m, n, name, participants } = params;

	if (!Number.isInteger(m) || !Number.isInteger(n)) {
		throw new Error("m and n must be integers");
	}
	if (m > n || m <= 0 || n <= 0) {
		throw new Error("Invalid m-of-n values. m must be <= n, and both must be > 0");
	}
	if (participants.length !== n) {
		throw new Error(`Expected ${n} participants, but got ${participants.length}`);
	}

	const publicKeys = participants.map(p => p.publicKey);
	if (new Set(publicKeys).size !== n) {
		throw new Error("Duplicate public keys found among participants.");
	}

	const walletId = await generateWalletId();

	// Use SecuxPsbt for address/redeem script generation
	const psbt = new SecuxPsbt(config.network);
	const { address, redeemScript } = psbt.initializeMultiSig(m, publicKeys);

	const walletData: Wallet = {
		walletId,
		address,
		redeemScript,
		m,
		n,
		name: name || "",
		creationTime: new Date().toISOString(),
		participants: participants.map(p => ({ publicKey: p.publicKey, userId: p.userId || "" })),
	};

	await db.put(`wallet:${walletId}`, walletData);

	return {
		walletId: walletData.walletId,
		address: walletData.address,
		redeemScript: walletData.redeemScript,
		m: walletData.m,
		n: walletData.n,
		name: walletData.name,
		creationTime: walletData.creationTime
	};
}

export async function submitSignature(transactionId: string, params: {
	publicKey: HexString, 
	signatures: Array<HexString>,
}) {
	const { publicKey, signatures } = params;

	if (typeof publicKey !== 'string' || publicKey.length === 0) {
		throw new Error("publicKey MUST be a non-empty string.");
	}

	const txKey = `tx:${transactionId}`;
	const transaction = await dbGet(txKey) as Transaction;

	if (!transaction) {
		throw new Error(`Transaction not found: ${transactionId}`);
	}

	if (transaction.status !== TransactionStatus.pending) {
		throw new Error(`Transaction is not in pending_signatures state. Current: ${transaction.status}`);
	}

	const walletData = await dbGet(`wallet:${transaction.walletId}`);
	if (!walletData) {
		throw new Error(`Wallet not found: ${transaction.walletId}`);
	}

	const psbt = SecuxPsbt.FromBuffer(Buffer.from(transaction.psbt, 'hex'), config.network);

	if (!transaction.signatures) {
		transaction.signatures = {};
	}

	const existingSig = Object.keys(transaction.signatures).find(key => key === publicKey);
	if (existingSig) {
		throw new Error(`User with public key ${publicKey} has already signed this transaction.`);
	}

	for (const [i, signature] of signatures.entries()) {
		psbt.submitSignature(i, {
			publickey: Buffer.from(publicKey, "hex"),
			signature: Buffer.from(signature, "hex"),
		});
	}

	transaction.signatures[publicKey] = signatures;
	transaction.signaturesReceived = Object.keys(transaction.signatures).length;

	transaction.psbt = psbt.toBuffer().toString("hex");
	if (transaction.signaturesReceived >= transaction.requiredSignatures) {
		transaction.status = TransactionStatus.allsigned;
		transaction.signedTransaction = psbt
			.finalizeAllInputs()
			.extractTransaction()
			.toHex();
	}

	await db.put(txKey, transaction);

	return {
		transactionId: transaction.transactionId,
		status: transaction.status,
		signaturesReceived: transaction.signaturesReceived,
		requiredSignatures: transaction.requiredSignatures - transaction.signaturesReceived,
	};
}

export async function getWalletDetails(walletId: string) {
	const walletData = await dbGet(`wallet:${walletId}`);
	if (!walletData) {
		return null;
	}
	return walletData;
}

export async function getWalletBalance(walletId: string) {
	const walletData = await dbGet(`wallet:${walletId}`) as Wallet;
	if (!walletData) {
		throw new Error(`Wallet not found: ${walletId}`);
	}

	try {
		const data = await utils.getAddressBalanceBlockbook(walletData.address);

		return {
			walletId,
			address: walletData.address,
			...data,
		}
	} catch (error: any) {
		console.error("Error getting balance from RPC:", error);
		throw new Error(`Failed to get wallet balance: ${error.message}`); // Re-throw with context
	}
}

export async function getTransactionHistory(walletId: string, page = 1) {
	const walletData = await dbGet(`wallet:${walletId}`) as Wallet;
	if (!walletData) {
		throw new Error(`Wallet not found: ${walletId}`);
	}

	try {
		const transactions = await utils.getAddressTransactions(walletData.address, page);

		return {
			walletId,
			address: walletData.address,
			transactions,
		}
	} catch (error: any) {
		console.error("Error getting balance from RPC:", error);
		throw new Error(`Failed to get wallet balance: ${error.message}`); // Re-throw with context
	}
}
