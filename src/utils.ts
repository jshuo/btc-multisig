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
			Authorization: `Basic ${Buffer.from('secux:4296').toString('base64')}`,
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

export async function generateNewUTXOBlocks() {
    console.log('⛏ Generating coinbase blocks...');
    await fetch('http://pufhsm2.itracxing.xyz:18443/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${Buffer.from('secux:4296').toString('base64')}`,
        },
        body: JSON.stringify({
            method: 'generatetoaddress',
            params: [1, "bcrt1qafyhjtqtr5nf4f8smskgaryw9u5d2496tnqjcrxeses37n2jarps9qfu6h"],
        }),
    });
}


export async function broadcastTransaction(signedTransaction: HexString) {
   
    await generateNewUTXOBlocks();

	const response = await fetch('http://pufhsm2.itracxing.xyz:18443/', {
		method: 'POST',
		headers: {
		  'Content-Type': 'application/json',
		  Authorization: `Basic ${Buffer.from('secux:4296').toString('base64')}`,
		},
		body: JSON.stringify({
		  jsonrpc: "1.0",
		  id: "sendrawtransaction",
		  method: "sendrawtransaction",
		  params: [signedTransaction],
		}),
	  });
	
	  if (!response.ok) {
		throw new Error(`❌ Failed to broadcast transaction: ${response.statusText}`);
	  }
	
	  const result = await response.json();
	  if (!result.result) {
		throw new Error('❌ No TXID returned from broadcast.');
	  }
	
	  const txid = result.result;
	  console.log('✅ Transaction broadcasted! TXID:', txid.trim());
	  return txid;
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

async function getUTXOs(address: string) {
	const rpcUser = 'secux';
	const rpcPass = '4296';
	const rpcUrl = 'http://pufhsm2.itracxing.xyz:18443/';
	
	const requestData = {
	  jsonrpc: "1.0",
	  id: "scantxoutset",
	  method: "scantxoutset",
	  params: ["start", [`addr(${address})`]]
	};
  
	try {
	  const response = await fetch(rpcUrl, {
		method: 'POST',
		headers: {
		  'Content-Type': 'application/json',
		  'Authorization': `Basic ${Buffer.from(`${rpcUser}:${rpcPass}`).toString('base64')}`
		},
		body: JSON.stringify(requestData)
	  });
  
	  if (!response.ok) {
		throw new Error(`❌ Failed to fetch UTXOs: ${response.statusText}`);
	  }
  
	  const data = await response.json();
	  const result = data.result;
	  if (!result.success || result.unspents.length === 0) {
		throw new Error('❌ No usable UTXOs found.');
	  }
  
	  return result.unspents;
  
	} catch (error) {
	  if (error instanceof Error) {
		  console.error('Error fetching UTXOs:', error.message);
	  } else {
		  console.error('Error fetching UTXOs:', error);
	  }
	  throw error;
	}
  }
export async function getUTXOsBlockbook(address: string) {
	try {
		const data = (await getUTXOs(address)).filter((u: { amount: number }) => u.amount > 0.02);
		const utxos = [];
		for (const utxo of data) {
			utxos.push({
				hash: utxo.txid,
				vout: utxo.vout,
				satoshis: Math.round(Number(utxo.amount) * 100000000),
			});
		}
	   
		return utxos;
	}
	catch (error) {
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
        const rpcUser = 'secux';
        const rpcPass = '4296';
        const rpcUrl = 'http://127.0.0.1:18443/wallet/test_wallet';

        const requestData = {
            jsonrpc: "1.0",
            id: "curltest",
            method: "listtransactions",
            params: ["*", 10, 0]
        };

        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(`${rpcUser}:${rpcPass}`).toString('base64')}`
            },
            body: JSON.stringify(requestData)
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch transactions: ${response.statusText}`);
        }

        const data = await response.json();
        if (data.error) {
            throw new Error(`Error from RPC: ${data.error.message}`);
        }

        const transactions = data.result.map((tx: any) => {
            return {
                txHash: tx.txid,
                amount: tx.amount,
                fee: tx.fee || 0,
                status: tx.confirmations > 0 ? "confirmed" : "unconfirmed",
                confirmationTime: tx.confirmations > 0 && tx.blocktime ? new Date(tx.blocktime * 1000).toISOString() : undefined,
                confirmations: tx.confirmations,
                direction: tx.category === "send" ? "sent" : "received"
            };
        });

        return transactions;
    } catch (error) {
        console.error(`Error fetching transactions for address ${address}:`, error);
        throw error;
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
