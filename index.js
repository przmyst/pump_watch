const {
    LiquidityPoolKeysV4,
    MARKET_STATE_LAYOUT_V3,
    Market,
    TOKEN_PROGRAM_ID,
} = require("@raydium-io/raydium-sdk");

const {
    Connection,
    PublicKey,
} = require("@solana/web3.js");

const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const RAYDIUM_POOL_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;

const connection = new Connection(RPC_ENDPOINT);
const seenTransactions = new Set();

subscribeToNewRaydiumPools();

function subscribeToNewRaydiumPools() {
    connection.onLogs(new PublicKey(RAYDIUM_POOL_V4_PROGRAM_ID), async (txLogs) => {
        if (seenTransactions.has(txLogs.signature)) {
            return;
        }
        seenTransactions.add(txLogs.signature);

        if (!findLogEntry('init_pc_amount', txLogs.logs)) {
            return;
        }

        const poolKeys = await fetchPoolKeysForLPInitTransactionHash(txLogs.signature);
        if (!poolKeys) return;
        if(poolKeys.quoteMint.toString().includes('pump')) {
            console.log(`https://dexscreener.com/solana/${poolKeys.id.toString()}`);
            console.log('New pool detected:', poolKeys.id.toString());
            console.log('Base Mint:', poolKeys.baseMint.toString());
            console.log('Quote Mint:', poolKeys.quoteMint.toString());
            console.log('LP Mint:', poolKeys.lpMint.toString());
        }
    });
}

function findLogEntry(needle, logEntries) {
    return logEntries.find(log => log.includes(needle)) || null;
}

async function fetchPoolKeysForLPInitTransactionHash(txSignature) {
    try {
        const tx = await connection.getParsedTransaction(txSignature, { maxSupportedTransactionVersion: 0 });
        if (!tx) {
            console.error('Failed to fetch transaction with signature ' + txSignature);
            return null;
        }
        const poolInfo = parsePoolInfoFromLpTransaction(tx);
        const marketInfo = await fetchMarketInfo(poolInfo.marketId);

        return {
            id: poolInfo.id,
            baseMint: poolInfo.baseMint,
            quoteMint: poolInfo.quoteMint,
            lpMint: poolInfo.lpMint,
            baseDecimals: poolInfo.baseDecimals,
            quoteDecimals: poolInfo.quoteDecimals,
            lpDecimals: poolInfo.lpDecimals,
            version: 4,
            programId: poolInfo.programId,
            authority: poolInfo.authority,
            openOrders: poolInfo.openOrders,
            targetOrders: poolInfo.targetOrders,
            baseVault: poolInfo.baseVault,
            quoteVault: poolInfo.quoteVault,
            withdrawQueue: poolInfo.withdrawQueue,
            lpVault: poolInfo.lpVault,
            marketVersion: 3,
            marketProgramId: poolInfo.marketProgramId,
            marketId: poolInfo.marketId,
            marketAuthority: Market.getAssociatedAuthority({
                programId: poolInfo.marketProgramId,
                marketId: poolInfo.marketId
            }).publicKey,
            marketBaseVault: marketInfo.baseVault,
            marketQuoteVault: marketInfo.quoteVault,
            marketBids: marketInfo.bids,
            marketAsks: marketInfo.asks,
            marketEventQueue: marketInfo.eventQueue,
        };
    } catch (e) {
        console.error('Error fetching pool keys:', e);
        return null;
    }
}

async function fetchMarketInfo(marketId) {
    const marketAccountInfo = await connection.getAccountInfo(marketId);
    if (!marketAccountInfo) {
        throw new Error('Failed to fetch market info for market ID ' + marketId.toBase58());
    }

    return MARKET_STATE_LAYOUT_V3.decode(marketAccountInfo.data);
}

function parsePoolInfoFromLpTransaction(txData) {
    const initInstruction = findInstructionByProgramId(
        txData.transaction.message.instructions,
        new PublicKey(RAYDIUM_POOL_V4_PROGRAM_ID)
    );
    if (!initInstruction) {
        throw new Error('Failed to find LP init instruction in transaction');
    }

    const baseMint = initInstruction.accounts[8];
    const quoteMint = initInstruction.accounts[9];
    const lpMint = initInstruction.accounts[7];
    const baseVault = initInstruction.accounts[10];
    const quoteVault = initInstruction.accounts[11];
    const baseAndQuoteSwapped = baseMint.toBase58() === SOL_MINT;

    const lpMintInitInstruction = findInitializeMintInInnerInstructionsByMintAddress(
        txData.meta?.innerInstructions ?? [],
        lpMint
    );
    if (!lpMintInitInstruction) {
        throw new Error('Failed to find LP mint init instruction in transaction');
    }

    const lpMintInstruction = findMintToInInnerInstructionsByMintAddress(
        txData.meta?.innerInstructions ?? [],
        lpMint
    );
    if (!lpMintInstruction) {
        throw new Error('Failed to find LP mint-to instruction in transaction');
    }

    const baseTransferInstruction = findTransferInstructionInInnerInstructionsByDestination(
        txData.meta?.innerInstructions ?? [],
        baseVault,
        TOKEN_PROGRAM_ID
    );
    if (!baseTransferInstruction) {
        throw new Error('Failed to find base transfer instruction in transaction');
    }

    const quoteTransferInstruction = findTransferInstructionInInnerInstructionsByDestination(
        txData.meta?.innerInstructions ?? [],
        quoteVault,
        TOKEN_PROGRAM_ID
    );
    if (!quoteTransferInstruction) {
        throw new Error('Failed to find quote transfer instruction in transaction');
    }

    const lpDecimals = lpMintInitInstruction.parsed.info.decimals;
    const logEntry = findLogEntry('init_pc_amount', txData.meta?.logMessages ?? []);
    const lpInitializationLogEntryInfo = extractLPInitializationLogEntryInfoFromLogEntry(logEntry ?? '');
    const basePreBalance = (txData.meta?.preTokenBalances ?? []).find(
        balance => balance.mint === baseMint.toBase58()
    );
    if (!basePreBalance) {
        throw new Error('Failed to find base token pre-balance entry');
    }
    const baseDecimals = basePreBalance.uiTokenAmount.decimals;

    return {
        id: initInstruction.accounts[4],
        baseMint,
        quoteMint,
        lpMint,
        baseDecimals: baseAndQuoteSwapped ? SOL_DECIMALS : baseDecimals,
        quoteDecimals: baseAndQuoteSwapped ? baseDecimals : SOL_DECIMALS,
        lpDecimals,
        programId: new PublicKey(RAYDIUM_POOL_V4_PROGRAM_ID),
        authority: initInstruction.accounts[5],
        openOrders: initInstruction.accounts[6],
        targetOrders: initInstruction.accounts[13],
        baseVault,
        quoteVault,
        withdrawQueue: new PublicKey("11111111111111111111111111111111"),
        lpVault: new PublicKey(lpMintInstruction.parsed.info.account),
        marketProgramId: initInstruction.accounts[15],
        marketId: initInstruction.accounts[16],
        baseReserve: parseInt(baseTransferInstruction.parsed.info.amount),
        quoteReserve: parseInt(quoteTransferInstruction.parsed.info.amount),
        lpReserve: parseInt(lpMintInstruction.parsed.info.amount),
        openTime: lpInitializationLogEntryInfo.open_time,
    };
}

function findInstructionByProgramId(instructions, programId) {
    return instructions.find(instr => instr.programId.equals(programId)) || null;
}

function findInitializeMintInInnerInstructionsByMintAddress(innerInstructions, mintAddress) {
    for (const inner of innerInstructions) {
        for (const instruction of inner.instructions) {
            if (instruction.parsed?.type === 'initializeMint' &&
                instruction.parsed.info.mint === mintAddress.toBase58()) {
                return instruction;
            }
        }
    }
    return null;
}

function findMintToInInnerInstructionsByMintAddress(innerInstructions, mintAddress) {
    for (const inner of innerInstructions) {
        for (const instruction of inner.instructions) {
            if (instruction.parsed?.type === 'mintTo' &&
                instruction.parsed.info.mint === mintAddress.toBase58()) {
                return instruction;
            }
        }
    }
    return null;
}

function findTransferInstructionInInnerInstructionsByDestination(innerInstructions, destinationAccount, programId) {
    for (const inner of innerInstructions) {
        for (const instruction of inner.instructions) {
            if (instruction.parsed?.type === 'transfer' &&
                instruction.parsed.info.destination === destinationAccount.toBase58() &&
                (!programId || instruction.programId.equals(programId))) {
                return instruction;
            }
        }
    }
    return null;
}

function extractLPInitializationLogEntryInfoFromLogEntry(lpLogEntry) {
    const lpInitializationLogEntryInfoStart = lpLogEntry.indexOf('{');
    if (lpInitializationLogEntryInfoStart === -1) {
        return {};
    }
    const jsonString = lpLogEntry.substring(lpInitializationLogEntryInfoStart);
    return JSON.parse(fixRelaxedJsonInLpLogEntry(jsonString));
}

function fixRelaxedJsonInLpLogEntry(relaxedJson) {
    return relaxedJson.replace(/([{,])\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
}
