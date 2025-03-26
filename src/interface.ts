export type HexString = string;

export type Wallet = {
	walletId: string;
	address: string;
	redeemScript: HexString;
	m: number;
	n: number;
	name: string; 
	creationTime: string;
	participants: Array<{ publicKey: HexString, userId: string }>;
}

export type Transaction = {
	transactionId: string;
	walletId: string;
	recipientAddress: string;
	amount: number;
	status: TransactionStatus;
	psbt: HexString;
	inputCount: number;
	requiredSignatures: number;
	signatures: { [publicKey: HexString]: Array<HexString> };
	signaturesReceived: number;
	signedTransaction?: HexString;
	initiatedTime: string;
	txHash?: HexString;
	broadcastTime?: string;
	note?: string;
};

export enum TransactionStatus {
	pending = "pending_signatures",
	allsigned = "finished_signatures",
	broadcasted = "broadcasted",
	finished = "confirmed",
	cancelled = "cancelled",
}
