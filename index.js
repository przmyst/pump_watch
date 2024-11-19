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
const seenTransactions = new Set(); // Use a Set for efficient lookups

subscribeToNewRaydiumPools();

function subscribeToNewRaydiumPools() {
    connection.onLogs(new PublicKey(RAYDIUM_POOL_V4_PROGRAM_ID), async (txLogs) => {
        try {
            if (!txLogs || !txLogs.signature || !txLogs.logs) {
                console.error('Invalid transaction logs received');
                return;
            }

            if (seenTransactions.has(txLogs.signature)) {
                return;
            }
            seenTransactions.add(txLogs.signature);

            if (!findLogEntry('init_pc_amount', txLogs.logs)) {
                return;
            }

            const poolKeys = await fetchPoolKeysForLPInitTransactionHash(txLogs.signature);
            if (!poolKeys) return;


            if(poolKeys.quoteMint.toString().includes('pump') || poolKeys.baseMint.toString().includes('pump')) {
                console.log(`https://dexscreener.com/solana/${poolKeys.id.toString()}`);
                if(poolKeys.quoteMint.toString().includes('pump')) {
                    console.log(`https://raydium.io/swap/?inputMint=${poolKeys.quoteMint.toString()}`)
                }else{
                    console.log(`https://raydium.io/swap/?inputMint=${poolKeys.baseMint.toString()}`)
                }
            }
        } catch (error) {
            console.error('Error processing logs:', error);
        }
    });
}

function findLogEntry(needle, logEntries) {
    if (!Array.isArray(logEntries)) {
        console.error('Invalid log entries');
        return null;
    }
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
        if (!poolInfo) {
            console.error('Failed to parse pool info from transaction');
            return null;
        }
        const marketInfo = await fetchMarketInfo(poolInfo.marketId);
        if (!marketInfo) {
            console.error('Failed to fetch market info');
            return null;
        }

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
    try {
        const marketAccountInfo = await connection.getAccountInfo(marketId);
        if (!marketAccountInfo) {
            console.error('Failed to fetch market info for market ID ' + marketId.toBase58());
            return null;
        }

        return MARKET_STATE_LAYOUT_V3.decode(marketAccountInfo.data);
    } catch (error) {
        console.error('Error fetching market info:', error);
        return null;
    }
}

function parsePoolInfoFromLpTransaction(txData) {
    try {
        if (!txData || !txData.transaction || !txData.transaction.message) {
            console.error('Invalid transaction data');
            return null;
        }

        const initInstruction = findInstructionByProgramId(
            txData.transaction.message.instructions,
            new PublicKey(RAYDIUM_POOL_V4_PROGRAM_ID)
        );
        if (!initInstruction) {
            console.error('Failed to find LP init instruction in transaction');
            return null;
        }

        const baseMint = initInstruction.accounts[8];
        const quoteMint = initInstruction.accounts[9];
        const lpMint = initInstruction.accounts[7];
        const baseVault = initInstruction.accounts[10];
        const quoteVault = initInstruction.accounts[11];
        const baseAndQuoteSwapped = baseMint.toBase58() === SOL_MINT;

        const innerInstructions = txData.meta?.innerInstructions ?? [];

        const lpMintInitInstruction = findInitializeMintInInnerInstructionsByMintAddress(
            innerInstructions,
            lpMint
        );
        if (!lpMintInitInstruction) {
            console.error('Failed to find LP mint init instruction in transaction');
            return null;
        }

        const lpMintInstruction = findMintToInInnerInstructionsByMintAddress(
            innerInstructions,
            lpMint
        );
        if (!lpMintInstruction) {
            console.error('Failed to find LP mint-to instruction in transaction');
            return null;
        }

        const baseTransferInstruction = findTransferInstructionInInnerInstructionsByDestination(
            innerInstructions,
            baseVault,
            TOKEN_PROGRAM_ID
        );
        if (!baseTransferInstruction) {
            console.error('Failed to find base transfer instruction in transaction');
            return null;
        }

        const quoteTransferInstruction = findTransferInstructionInInnerInstructionsByDestination(
            innerInstructions,
            quoteVault,
            TOKEN_PROGRAM_ID
        );
        if (!quoteTransferInstruction) {
            console.error('Failed to find quote transfer instruction in transaction');
            return null;
        }

        const lpDecimals = lpMintInitInstruction.parsed.info.decimals;
        const logEntry = findLogEntry('init_pc_amount', txData.meta?.logMessages ?? []);
        if (!logEntry) {
            console.error('Failed to find init_pc_amount log entry');
            return null;
        }
        const lpInitializationLogEntryInfo = extractLPInitializationLogEntryInfoFromLogEntry(logEntry);
        if (!lpInitializationLogEntryInfo) {
            console.error('Failed to extract LP initialization log entry info');
            return null;
        }
        const basePreBalance = (txData.meta?.preTokenBalances ?? []).find(
            balance => balance.mint === baseMint.toBase58()
        );
        if (!basePreBalance || !basePreBalance.uiTokenAmount) {
            console.error('Failed to find base token pre-balance entry');
            return null;
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
    } catch (error) {
        console.error('Error parsing pool info from transaction:', error);
        return null;
    }
}

function findInstructionByProgramId(instructions, programId) {
    if (!Array.isArray(instructions) || !programId) {
        console.error('Invalid instructions or program ID');
        return null;
    }
    return instructions.find(instr => instr.programId.equals(programId)) || null;
}

function findInitializeMintInInnerInstructionsByMintAddress(innerInstructions, mintAddress) {
    if (!Array.isArray(innerInstructions) || !mintAddress) {
        console.error('Invalid inner instructions or mint address');
        return null;
    }
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
    if (!Array.isArray(innerInstructions) || !mintAddress) {
        console.error('Invalid inner instructions or mint address');
        return null;
    }
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
    if (!Array.isArray(innerInstructions) || !destinationAccount) {
        console.error('Invalid inner instructions or destination account');
        return null;
    }
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
    try {
        const lpInitializationLogEntryInfoStart = lpLogEntry.indexOf('{');
        if (lpInitializationLogEntryInfoStart === -1) {
            console.error('Failed to find JSON in LP initialization log entry');
            return null;
        }
        const jsonString = lpLogEntry.substring(lpInitializationLogEntryInfoStart);
        const fixedJsonString = fixRelaxedJsonInLpLogEntry(jsonString);
        return JSON.parse(fixedJsonString);
    } catch (error) {
        console.error('Error extracting LP initialization log entry info:', error);
        return null;
    }
}

function fixRelaxedJsonInLpLogEntry(relaxedJson) {
    if (typeof relaxedJson !== 'string') {
        console.error('Invalid relaxed JSON string');
        return '';
    }
    return relaxedJson.replace(/([{,])\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
}
