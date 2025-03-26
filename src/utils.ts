import { Level } from 'level';
import { sha256 } from "hash.js";
import { CoinType, ScriptType, SecuxBTC } from "@secux/app-btc";
import { Base58 } from "@secux/utility/lib/bs58";
import { HexString, Wallet } from './interface';
import { getByteCount } from './getByteCount';

export const config = {
	network: CoinType.BITCOIN,
	rpcUrl: "https://bitcoin-rpc.publicnode.com",
	blockbookUrl: "https://btc1.trezor.io",
}

// Database setup
export const db = new Level<string, any>('./walletDB', { valueEncoding: 'json' });

// Helper function to promisify LevelDB operations
export async function dbGet(key: string) {
	try {
		return await db.get(key);
	} catch (error: any) {
		if (error.notFound) {
			return undefined;
		}
		throw error;
	}
}


async function bitcoinRpcCall(method: string, params: any[]) {
	const response = await fetch(config.rpcUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			method,
			params,
			id: 1, // Can be any unique ID
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Bitcoin RPC error: ${response.status} - ${errorText}`);
	}

	const data = await response.json();

	if (data.error) {
		throw new Error(`Bitcoin RPC error: ${data.error.message}`);
	}

	return data.result;
}

export async function broadcastTransaction(signedTransaction: HexString) {
	try {
		// Broadcast using the RPC
		const txHash = await bitcoinRpcCall('sendrawtransaction', [signedTransaction]);
		return txHash;
	} catch (error: any) {
		throw new Error(`Failed to broadcast transaction: ${error.message}`);
	}
}

export async function getTransactionStatus(txHash: HexString) {
	try {
		// Fetch transaction details from the blockchain
		const txDetails = await bitcoinRpcCall('getrawtransaction', [txHash, true]);
		return txDetails;
	} catch (error) {
		// Handle errors (e.g., transaction not found on the blockchain)
		console.error("Error fetching transaction details:", error);
	}
}

export async function getFeeRateRecommendations() {
	try {
		const estimatesmartfee = await bitcoinRpcCall('estimatesmartfee', [6]); // Estimate fee for 6 blocks confirmation
		// estimatesmartfee.feerate is in BTC/kB, convert to sat/vbyte
		const feeRateSatVByte = Math.ceil(estimatesmartfee.feerate * 100000000 / 1000);
		return {
			fastest: feeRateSatVByte * 2,     // Example values
			normal: feeRateSatVByte,
			economical: Math.max(1, Math.floor(feeRateSatVByte * 0.8)), // Ensure at least 1 sat/vbyte
			unit: "sat/vbyte",
			lastUpdated: new Date().toISOString()
		};
	} catch (error) {
		console.error("Error to get fee:", error);
		throw error;
	}
}

export async function healthCheck() {
	try {
		const blockchainInfo = await bitcoinRpcCall('getblockchaininfo', []);
		if (blockchainInfo && blockchainInfo.blocks) { // Basic check for a valid response
			return {
				status: "ok",
				blocks: blockchainInfo.blocks, //  Include blockchain height
				timestamp: new Date().toISOString()
			};
		} else {
			return {
				status: "error",
				message: "Invalid response from Bitcoin RPC",
				timestamp: new Date().toISOString()
			};
		}

	} catch (error: any) {
		return {
			status: "error",
			message: error.message,
			timestamp: new Date().toISOString()
		};
	}
}


async function blockbookApiCall(path: string) {
	const response = await fetch(`${config.blockbookUrl}/api/v2/${path}`);

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Blockbook API error: ${response.status} - ${errorText}`);
	}
	return await response.json();
}

export async function getUTXOsBlockbook(address: string) {
	try {
		const data = await blockbookApiCall(`utxo/${address}?confirmed=true`);
		const utxos = [];

		for (const utxo of data) {
			utxos.push({
				hash: utxo.txid,
				vout: utxo.vout,
				satoshis: Number(utxo.value),
			});
		}
		return utxos;
	} catch (error) {
		console.error("Error fetching UTXOs from Blockbook:", error);
		throw error;
	}
}

export async function getAddressBalanceBlockbook(address: string) {
	try {
		const data = await blockbookApiCall(`address/${address}?details=basic`);
		return {
			confirmedBalance: data.balance,
			unconfirmedBalance: data.unconfirmedBalance,
		};
	} catch (error) {
		console.error("Error to get balance from Blockbook", error)
		throw error
	}
}

export async function getAddressTransactions(address: string, page: number) {
	try {
		const data = await blockbookApiCall(`address/${address}?details=txslight&page=${page}`);
		const transactions: Array<{
			txHash: string,
			amount: number,
			fee: number,
			status: string,
			confirmationTime?: string,
			confirmations: number,
			direction: string
		}> = [];

		if (data.transactions) {
			for (const tx of data.transactions) {
				let direction = "received"; // Default to "received"
				let amount = 0;

				// Check if the wallet address is involved in any of the outputs.
				for (const vout of tx.vout) {
					if (vout.addresses && vout.addresses.includes(address)) {
						amount += Number(vout.value);  // to satoshis.
					}
				}

				// check sends
				let sent_amount = 0
				for (const vin of tx.vin) {
					if (vin.txid) {
						const prevRawTx = await blockbookApiCall(`tx/${vin.txid}`)
						if (prevRawTx && prevRawTx.vout) {
							const vout = prevRawTx.vout[vin.vout]
							if (vout?.addresses && vout.addresses.includes(address)) {
								sent_amount += Number(vout.value); // to satoshis
								direction = "sent"
							}
						}
					}
				}

				const simplifiedTx = {
					txHash: tx.txid,
					amount: direction === "sent" ? sent_amount : amount,
					fee: Number(tx.fees),
					status: tx.confirmations > 0 ? "confirmed" : "unconfirmed",
					confirmationTime: tx.confirmations > 0 && tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : undefined,
					confirmations: tx.confirmations,
					direction: direction
				};
				transactions.push(simplifiedTx);
			}
		}
		return transactions
	} catch (error) {
		console.error(`Error fetching transactions for address ${address}:`, error);
		throw error
	}
}

export async function estimateVirtualSize(walletId: string, recipientAddress: string) {
	const walletData = await dbGet(`wallet:${walletId}`) as Wallet;
	if (!walletData) {
		throw new Error(`Wallet not found: ${walletId}`);
	}

	let scriptType = '';
	switch (SecuxBTC.getScriptType(recipientAddress, config.network)) {
		case ScriptType.P2PKH: 
			scriptType = "P2PKH";
			break;
		case ScriptType.P2SH: 
			scriptType = "P2SH";
			break;
		case ScriptType.P2WPKH:
			scriptType = "P2WPKH";
			break;
		case ScriptType.P2WSH:
			scriptType = "P2WSH";
			break;
		case ScriptType.P2TR:
			scriptType = "P2TR";
			break;

		default:
			throw Error("unsupported address");
	}

	const inputCount = (await getUTXOsBlockbook(walletData.address)).length;
	const outputs = {
		[scriptType]: 1,
	};
	if (outputs["P2WSH"]) {
		outputs["P2WSH"] = 2;
	}
	else {
		outputs["P2WSH"] = 1;
	}

	const vSize = getByteCount(
		{ [`MULTISIG-P2WSH:${walletData.m}-${walletData.n}`]: inputCount },
		outputs
	);
	return vSize;
}


// Helper function to generate a unique, auto-incrementing ID using LevelDB
async function generateId(prefix = "secux_btc_multisig") {
	const key = `_id:${prefix}`;
	try {
		let lastId = await db.get(key);
		lastId = (parseInt(lastId, 10) + 1).toString();
		await db.put(key, lastId);
		return `${prefix}${lastId.padStart(16, '0')}`; // Pad for consistent length

	} catch (error: any) {
		if (error.notFound) {
			// First time, initialize the counter
			await db.put(key, '1');
			return `${prefix}0000000000000001`;
		}
		throw error;
	}
}

export function customHash(data: Buffer) {
	const hex = data.toString("hex");
	const hash = sha256().update(hex).digest();
	return Base58.encode(hash);
}

export async function generateWalletId() {
	const id = await generateId();
	return customHash(Buffer.from(id));
}
