import { ABIs } from "@lib/eth";
import { TokenInitInfo } from "@lib/types";
import fetch from "@lib/utils/fetch";
import { logger } from "@lib/utils/logger";
import BigNumber from "bignumber.js";
import { ethers } from "ethers";
import { APIClient } from "../api";
import { RestModels } from "../models";
import { appendHexPrefix, Blockchain, EthNetworkConfig, NetworkConfig, NetworkConfigProvider, stripHexPrefix, SWTHAddress } from "../utils";

export interface ETHClientOpts {
  configProvider: NetworkConfigProvider,
  blockchain: Blockchain,
}

interface ETHTxParams {
  gasPriceGwei: BigNumber
  gasLimit: BigNumber
  ethAddress: string
  signer: ethers.Signer
}

export interface LockParams extends ETHTxParams {
  address: Uint8Array
  amount: BigNumber
  token: RestModels.Token
  signCompleteCallback?: () => void
}
export interface ApproveERC20Params extends ETHTxParams {
  token: RestModels.Token
  signCompleteCallback?: () => void
}

export interface EthersTransactionResponse extends ethers.Transaction {
  wait: () => Promise<ethers.Transaction>
}

export const FEE_MULTIPLIER = ethers.BigNumber.from(2)

export class ETHClient {
  static SUPPORTED_BLOCKCHAINS = [Blockchain.BinanceSmartChain, Blockchain.Ethereum]
  static BLOCKCHAIN_KEY = {
    [Blockchain.BinanceSmartChain]: "Bsc",
    [Blockchain.Ethereum]: "Eth",
  }

  private constructor(
    public readonly configProvider: NetworkConfigProvider,
    public readonly blockchain: Blockchain,
  ) { }

  public static instance(opts: ETHClientOpts) {
    const { configProvider, blockchain } = opts

    if (!ETHClient.SUPPORTED_BLOCKCHAINS.includes(blockchain))
      throw new Error(`unsupported blockchain - ${blockchain}`)

    return new ETHClient(configProvider, blockchain)
  }

  public async getExternalBalances(api: APIClient, address: string, whitelistDenoms?: string[]) {
    const tokenList = await api.getTokens()
    const lockProxyAddress = this.getLockProxyAddress().toLowerCase()
    const tokens = tokenList.filter(token =>
      token.blockchain == this.blockchain &&
      token.asset_id.length == 40 &&
      token.lock_proxy_hash.toLowerCase() == stripHexPrefix(lockProxyAddress) &&
      (!whitelistDenoms || whitelistDenoms.includes(token.denom))
    )
    const assetIds = tokens.map(token => appendHexPrefix(token.asset_id))
    const provider = this.getProvider()
    const contractAddress = this.getBalanceReaderAddress()
    const contract = new ethers.Contract(contractAddress, ABIs.balanceReader, provider)

    const balances = await contract.getBalances(address, assetIds)
    for (let i = 0; i < tokens.length; i++) {
      (tokens[i] as any).external_balance = balances[i].toString()
    }

    return tokens
  }

  public async approveERC20(params: ApproveERC20Params): Promise<EthersTransactionResponse> {
    const { token, gasPriceGwei, gasLimit, ethAddress, signer } = params
    const contractAddress = token.asset_id

    const rpcProvider = this.getProvider()
    const contract = new ethers.Contract(contractAddress, ABIs.erc20, rpcProvider)

    const nonce = await rpcProvider.getTransactionCount(ethAddress)
    const approveResultTx = await contract.connect(signer).approve(
      token.lock_proxy_hash,
      ethers.constants.MaxUint256,
      {
        nonce,
        gasPrice: gasPriceGwei.shiftedBy(9).toString(10),
        gasLimit: gasLimit.toString(10),
      },
    )

    return approveResultTx
  }

  public async checkAllowanceERC20(token: RestModels.Token, owner: string, spender: string) {
    const contractAddress = token.asset_id
    const rpcProvider = this.getProvider()
    const contract = new ethers.Contract(contractAddress, ABIs.erc20, rpcProvider)
    const allowance = await contract.allowance(owner, spender)
    return new BigNumber(allowance.toString())
  }

  public async lockDeposit(params: LockParams): Promise<EthersTransactionResponse> {
    const { address, token, amount, gasPriceGwei, gasLimit, ethAddress, signer } = params

    if (gasLimit.lt(150000)) {
      throw new Error("Minimum gas required: 150,000")
    }

    const networkConfig = this.getNetworkConfig();

    const assetId = appendHexPrefix(token.asset_id);
    const targetProxyHash = appendHexPrefix(this.getTargetProxyHash(token));
    const feeAddress = appendHexPrefix(networkConfig.FeeAddress);
    const toAssetHash = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(token.denom))

    const swthAddress = ethers.utils.hexlify(address)
    const contractAddress = this.getLockProxyAddress()

    const rpcProvider = this.getProvider()

    const nonce = await rpcProvider.getTransactionCount(ethAddress)
    const contract = new ethers.Contract(contractAddress, ABIs.lockProxy, rpcProvider)
    const lockResultTx = await contract.connect(signer).lock(
      assetId, // _assetHash
      targetProxyHash, // _targetProxyHash
      swthAddress, // _toAddress
      toAssetHash, // _toAssetHash
      feeAddress, // _feeAddress
      [ // _values
        amount.toString(), // amount
        "0", // feeAmount
        amount.toString(), // callAmount
      ],
      {
        nonce,
        value: "0",
        gasPrice: gasPriceGwei.shiftedBy(9).toString(10),
        gasLimit: gasLimit.toString(10),

        // add tx value for ETH deposits, omit if ERC20 token
        ...token.asset_id === "0000000000000000000000000000000000000000" && {
          value: amount.toString(),
        },
      },
    )

    return lockResultTx
  }

  public async getDepositContractAddress(swthBech32Addres: string, ownerEthAddress: string) {
    const network = this.getNetworkConfig().Network
    const addressBytes = SWTHAddress.getAddressBytes(swthBech32Addres, network)
    const swthAddress = ethers.utils.hexlify(addressBytes)

    const provider = this.getProvider()
    const contractAddress = this.getLockProxyAddress()
    logger("getDepositContractAddress lock proxy", contractAddress)
    const contract = new ethers.Contract(contractAddress, ABIs.lockProxy, provider)
    const walletAddress = await contract.getWalletAddress(ownerEthAddress, swthAddress, this.getWalletBytecodeHash())

    logger("getDepositContractAddress", swthBech32Addres, ownerEthAddress, walletAddress)

    return walletAddress
  }

  public async sendDeposit(token, swthAddress: string, ethAddress: string, getSignatureCallback?: (msg: string) => Promise<{ address: string, signature: string }>) {
    logger("sendDeposit", token, swthAddress, ethAddress)
    const depositAddress = await this.getDepositContractAddress(swthAddress, ethAddress)
    const feeAmount = await this.getDepositFeeAmount(token, depositAddress)
    const amount = ethers.BigNumber.from(token.external_balance)
    if (amount.lt(feeAmount.mul(FEE_MULTIPLIER))) {
      return "insufficient balance"
    }

    const networkConfig = this.getNetworkConfig()

    const assetId = appendHexPrefix(token.asset_id)
    const targetProxyHash = appendHexPrefix(this.getTargetProxyHash(token))
    const feeAddress = appendHexPrefix(networkConfig.FeeAddress)
    const toAssetHash = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(token.denom))
    const nonce = Math.floor(Math.random() * 1000000000) // random nonce to prevent replay attacks
    const message = ethers.utils.solidityKeccak256(
      ["string", "address", "bytes", "bytes", "bytes", "uint256", "uint256", "uint256"],
      ["sendTokens", assetId, targetProxyHash, toAssetHash, feeAddress, amount, feeAmount, nonce]
    )
    logger("sendDeposit message", message)

    let signatureResult: {
      owner: string
      r: string
      s: string
      v: string
    } | undefined

    const { address, signature } = await getSignatureCallback(message)
    const signatureBytes = ethers.utils.arrayify(appendHexPrefix(signature))
    const rsv = ethers.utils.splitSignature(signatureBytes)

    logger("sign result", address, signature)

    signatureResult = {
      owner: address,
      v: rsv.v.toString(),
      r: rsv.r,
      s: rsv.s,
    }

    const network = this.getNetworkConfig().Network;
    const addressBytes = SWTHAddress.getAddressBytes(swthAddress, network)
    const swthAddressHex = ethers.utils.hexlify(addressBytes)
    const body = {
      OwnerAddress: signatureResult.owner,
      SwthAddress: swthAddressHex,
      AssetHash: assetId,
      TargetProxyHash: targetProxyHash,
      ToAssetHash: toAssetHash,
      Amount: amount.toString(),
      FeeAmount: feeAmount.toString(),
      FeeAddress: feeAddress,
      Nonce: nonce.toString(),
      V: signatureResult.v,
      R: signatureResult.r,
      S: signatureResult.s,
    }

    const result = await fetch(
      this.getPayerUrl() + "/deposit",
      { method: "POST", body: JSON.stringify(body) }
    )
    logger("fetch result", result)
    return result
  }

  public async getDepositFeeAmount(token: RestModels.Token, depositAddress: string) {
    const feeInfo = await this.getFeeInfo(token.denom)
    if (!feeInfo.details?.deposit?.fee) {
      throw new Error("unsupported token")
    }
    if (token.blockchain !== this.blockchain) {
      throw new Error("unsupported token")
    }

    let feeAmount = ethers.BigNumber.from(feeInfo.details.deposit.fee)
    const walletContractDeployed = await this.isContract(depositAddress)
    if (!walletContractDeployed) {
      feeAmount = feeAmount.add(ethers.BigNumber.from(feeInfo.details.createWallet.fee))
    }

    return feeAmount
  }

  public async getFeeInfo(denom: string) {
    const networkConfig = this.getNetworkConfig();
    const url = `${networkConfig.FeeURL}/fees?denom=${denom}`
    const result = await fetch(url).then(res => res.json()) as RestModels.FeeResult
    return result
  }

  public async isContract(address: string) {
    const provider = this.getProvider()
    const code = await provider.getCode(address)
    // non-contract addresses should return 0x
    return code !== "0x"
  }

  public async retrieveERC20Info(address: string): Promise<TokenInitInfo> {
    const provider = this.getProvider()
    const contract = new ethers.Contract(address, ABIs.erc20, provider)
    const decimals = await contract.decimals()
    const name = await contract.name()
    const symbol = await contract.symbol()

    return { address, decimals, name, symbol }
  }

  public getEthSigner(privateKey: string): ethers.Signer {
    return new ethers.Wallet(privateKey, this.getProvider());
  }

  /**
   * TargetProxyHash is a hash of token originator address that is used
   * for lockproxy asset registration and identification
   * 
   * @param token
   */
  public getTargetProxyHash(token: RestModels.Token) {
    const networkConfig = this.getNetworkConfig();
    const addressBytes = SWTHAddress.getAddressBytes(token.originator, networkConfig.Network)
    const addressHex = stripHexPrefix(ethers.utils.hexlify(addressBytes))
    return addressHex
  }

  public getProvider() {
    return new ethers.providers.JsonRpcProvider(this.getProviderUrl())
  }

  public getNetworkConfig(): NetworkConfig {
    return this.configProvider.getConfig();
  }

  public getConfig(): EthNetworkConfig {
    const networkConfig = this.getNetworkConfig();
    return networkConfig[ETHClient.BLOCKCHAIN_KEY[this.blockchain]];
  }

  public getPayerUrl() {
    return this.getConfig().PayerURL;
  }

  public getProviderUrl() {
    return this.getConfig().RpcURL;
  }

  public getLockProxyAddress() {
    return this.getConfig().LockProxyAddr;
  }

  public getBalanceReaderAddress() {
    return this.getConfig().BalanceReader;
  }

  public getWalletBytecodeHash() {
    return this.getConfig().ByteCodeHash;
  }
}
