const { ethers } = require("ethers");
const fs = require("fs");
const { Select, Input } = require("enquirer");
const ora = require("ora");
const chains = require("./chains.json");

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};

// Utility functions
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getReliableProvider(chain) {
  const spinner = ora(`${colors.yellow}🔍 Connecting to ${chain.name}...${colors.reset}`).start();
  
  // Try all RPC endpoints until we find a working one
  for (const url of chain.rpc) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      await provider.getBlockNumber();
      spinner.succeed(`${colors.green}✅ Connected to RPC: ${url}${colors.reset}`);
      return provider;
    } catch (error) {
      spinner.fail(`${colors.red}❌ Failed RPC: ${url} - ${error.shortMessage || error.message}${colors.reset}`);
      spinner.start();
    }
  }
  
  throw new Error("No working RPC endpoints found");
}

async function main() {
  try {
    // Network selection
    const chainPrompt = new Select({
      name: "network",
      message: `${colors.cyan}🌍 Select network:${colors.reset}`,
      choices: chains.map(c => `${c.name} (${c.symbol})`)
    });

    const selected = await chainPrompt.run();
    const chain = chains.find(c => selected.includes(c.name));
    ora().succeed(`${colors.green}🌐 Selected: ${chain.name}${colors.reset}`);

    // Load data
    const destLoader = ora(`${colors.cyan}📖 Loading destinations...${colors.reset}`).start();
    const destinations = JSON.parse(fs.readFileSync("addresses.json", "utf-8"))
      .map(d => d.address)
      .filter(a => ethers.isAddress(a));
    destLoader.succeed(`${colors.green}📄 ${destinations.length} destinations loaded${colors.reset}`);

    const sourceLoader = ora(`${colors.cyan}📖 Loading sources...${colors.reset}`).start();
    const sources = fs.readFileSync("sources.txt", "utf-8")
      .split("\n")
      .map(l => l.trim().replace("0x", ""))
      .filter(l => l.length === 64);
    sourceLoader.succeed(`${colors.green}📄 ${sources.length} sources loaded${colors.reset}`);

    if (destinations.length !== sources.length) {
      throw new Error(`Mismatch: ${sources.length} sources vs ${destinations.length} destinations`);
    }

    // Setup provider
    const provider = await getReliableProvider(chain);
    const MIN_BALANCE = ethers.parseEther("0.0000099"); // ~$0.03
    const RPC_DELAY = 1500; // 1.5 seconds between txs

    // Get send amount
    const amount = await new Input({
      message: `${colors.yellow}💸 Amount to send (${chain.symbol}):${colors.reset}`,
      validate: v => !isNaN(v) && v > 0 || "Must be positive number"
    }).run();
    
    const parsedAmount = ethers.parseEther(amount);
    let successCount = 0;

    const mainSpinner = ora(`${colors.magenta}🔄 Starting ${sources.length} transfers...${colors.reset}`).start();

    for (let i = 0; i < sources.length; i++) {
      const wallet = new ethers.Wallet(sources[i], provider);
      const destination = destinations[i];
      const walletSpinner = ora(`${colors.cyan}👛 Wallet ${i+1}/${sources.length} (${wallet.address})${colors.reset}`).start();

      try {
        // Check balance
        const balance = await provider.getBalance(wallet.address);
        
        if (balance < MIN_BALANCE) {
          walletSpinner.fail(`${colors.yellow}⚠️  Low balance: ${ethers.formatEther(balance)} ${chain.symbol}${colors.reset}`);
          continue;
        }

        if (balance < parsedAmount) {
          walletSpinner.fail(`${colors.red}❌ Insufficient funds: ${ethers.formatEther(balance)} ${chain.symbol}${colors.reset}`);
          continue;
        }

        // Build transaction
        const tx = {
          to: destination,
          value: parsedAmount,
          nonce: await wallet.getNonce(),
          gasLimit: 21000,
          type: 2,
          chainId: chain.chainId
        };

        // Get dynamic gas prices
        const feeData = await provider.getFeeData();
        tx.maxFeePerGas = feeData.maxFeePerGas;
        tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;

        // Send transaction
        let attempts = 0;
        while (attempts < 3) {
          attempts++;
          try {
            const sentTx = await wallet.sendTransaction(tx);
            const receipt = await sentTx.wait().catch(async (error) => {
              const actualReceipt = await provider.getTransactionReceipt(sentTx.hash);
              return actualReceipt || Promise.reject(error);
            });

            if (receipt.status === 1) {
              successCount++;
              walletSpinner.succeed(`${colors.green}✅ Sent ${amount} ${chain.symbol} to ${destination}${colors.reset}`);
              break;
            } else {
              throw new Error('Transaction failed');
            }
          } catch (error) {
            if (attempts === 3) {
              walletSpinner.fail(`${colors.red}❌ Failed after 3 attempts: ${error.shortMessage || error.message}${colors.reset}`);
              break;
            }
            
            await delay(1000 * Math.pow(2, attempts));
            walletSpinner.text = `${colors.yellow}🔄 Retry ${attempts}/3 (${error.shortMessage || error.message})${colors.reset}`;
          }
        }

      } catch (error) {
        walletSpinner.fail(`${colors.red}❌ Critical error: ${error.shortMessage || error.message}${colors.reset}`);
      } finally {
        await delay(RPC_DELAY);
      }
    }

    mainSpinner.succeed(`${colors.green}
✨ Transfer summary:
   Processed: ${sources.length} wallets
   Success: ${successCount}
   Failed: ${sources.length - successCount}
   Success rate: ${((successCount/sources.length)*100).toFixed(1)}%${colors.reset}`);

  } catch (error) {
    ora().fail(`${colors.red}🔥 Fatal error: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

main().then(() => process.exit(0));