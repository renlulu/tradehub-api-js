import BigNumber from "bignumber.js";
import { APIClient } from "../api";
import { ETHClient, NEOClient } from "../clients";
import TokenClient from "../clients/TokenClient";
import { RestResponse as _RestResponse, RPCParams as _RPCParams } from "../models";
import { Blockchain, Network, Network as _Network, NetworkConfig, NetworkConfigProvider, NetworkConfigs, SimpleMap } from "../utils";
import { TradeHubSigner, TradeHubWallet } from "../wallet";
import { WSConnector } from "../websocket";
import { ModAdmin, ModGovernance, ModMarket, ModOrder } from "./modules";
import ModAccount from "./modules/account";
import { SDKProvider } from "./modules/module";

export interface TradeHubSDKInitOpts {
  network?: Network
  debugMode?: boolean
  txFees?: SimpleMap<BigNumber>

  config?: Partial<NetworkConfig>
}

const DEFAULT_OPTS: TradeHubSDKInitOpts = {
  network: Network.MainNet,
}

class TradeHubSDK implements SDKProvider, NetworkConfigProvider {
  static APIClient = APIClient

  network: Network
  api: APIClient
  debugMode: boolean
  configOverride: Partial<NetworkConfig>
  initialized: boolean

  networkConfig: NetworkConfig

  ws: WSConnector

  neo: NEOClient
  eth: ETHClient
  bsc: ETHClient

  token: TokenClient

  // modules
  admin: ModAdmin
  account: ModAccount
  order: ModOrder
  market: ModMarket
  governance: ModGovernance

  // initialized by calling TradeHubSDK.connect(TradeHubWallet)
  wallet?: TradeHubWallet
  txFees?: SimpleMap<BigNumber>

  constructor(opts: TradeHubSDKInitOpts = DEFAULT_OPTS) {
    this.debugMode = opts.debugMode ?? false

    this.network = opts.network ?? DEFAULT_OPTS.network;
    this.configOverride = opts.config ?? {};
    this.txFees = opts.txFees;
    this.initialized = false;

    this.networkConfig = {
      ...NetworkConfigs[this.network],
      ...this.configOverride,
    };

    this.api = new APIClient(this.networkConfig.RestURL, {
      debugMode: this.debugMode,
    });

    this.ws = new WSConnector({
      endpoint: this.networkConfig.WsURL,
      debugMode: this.debugMode,
    });

    this.log("constructor result opts", this.generateOpts())

    if (this.debugMode) {
      this.log("setting BigNumber print mode for console logs")
      BigNumber.prototype[require('util').inspect.custom] = BigNumber.prototype.valueOf;
    }

    this.neo = NEOClient.instance({
      configProvider: this,
    });

    this.eth = ETHClient.instance({
      configProvider: this,
      blockchain: Blockchain.Ethereum,
    });

    this.bsc = ETHClient.instance({
      configProvider: this,
      blockchain: Blockchain.BinanceSmartChain,
    });

    this.token = TokenClient.instance(this.api);

    // initialize modules
    this.order = new ModOrder(this);
    this.market = new ModMarket(this);
    this.governance = new ModGovernance(this);
    this.admin = new ModAdmin(this);
    this.account = new ModAccount(this);
  }

  public getConfig(): NetworkConfig {
    return this.networkConfig;
  }

  public generateOpts(): TradeHubSDKInitOpts {
    return {
      network: this.network,
      debugMode: this.debugMode,
      txFees: this.txFees,
    }
  }

  public log(...args: any[]) {
    if (this.debugMode) {
      console.log.apply(console.log, [this.constructor.name, ...args]);
    }
  }

  public async reloadTxnFees() {
    this.log("reloadTxnFees…");
    this.txFees = await this.api.getTxnFees();
  }

  public static parseNetwork(network: string, defaultNetwork: Network | null = DEFAULT_OPTS.network) {
    switch (network?.toLowerCase?.()) {
      case "main":
      case "mainnet":
        return Network.MainNet;
      case "test":
      case "testnet":
        return Network.TestNet;
      case "dev":
      case "devnet":
        return Network.DevNet;
      case "local":
      case "localhost":
        return Network.LocalHost;
    }

    return defaultNetwork;
  }

  /* CONNECT WALLET FUNCTIONS */

  public async initialize(wallet?: TradeHubWallet) {
    this.log("initialize…");
    await this.reloadTxnFees();
    await this.ws.connect();
    await this.token.initialize();

    if (wallet) {
      this.log("reloading wallet account");
      await wallet.init();

      this.log("update wallet account", wallet.account, "sequence", wallet.sequence);

      if (wallet.account === 0) {
        this.log(`account is not initialized, please send funds to ${wallet.bech32Address} before initiating a transaction.`)
      }
    }

    this.initialized = true;
    this.log("initialize complete");
  }

  public async connect(wallet: TradeHubWallet) {
    await this.initialize(wallet);
    return new ConnectedTradeHubSDK(wallet, this.generateOpts())
  }

  public async connectWithPrivateKey(privateKey: string | Buffer) {
    const wallet = TradeHubWallet.withPrivateKey(privateKey, {
      debugMode: this.debugMode,
      network: this.network,
    })
    return this.connect(wallet)
  }

  public async connectWithMnemonic(mnemonic: string) {
    const wallet = TradeHubWallet.withMnemonic(mnemonic, {
      debugMode: this.debugMode,
      network: this.network,
    })
    return this.connect(wallet)
  }

  public async connectWithSigner(signer: TradeHubSigner, bech32Address: string) {
    const wallet = TradeHubWallet.withSigner(signer, bech32Address, {
      debugMode: this.debugMode,
      network: this.network,
    })
    return this.connect(wallet)
  }

  public getConnectedWallet(): TradeHubWallet {
    return this.checkWallet();
  }

  private checkWallet(): TradeHubWallet {
    if (!this.wallet) {
      throw new Error("wallet not connected");
    }

    return this.wallet;
  }
}

class ConnectedTradeHubSDK extends TradeHubSDK {
  wallet: TradeHubWallet

  constructor(wallet: TradeHubWallet, opts: TradeHubSDKInitOpts = DEFAULT_OPTS) {
    super(opts)

    if (!opts.txFees) {
      console.warn("ConnectedTradeHubSDK initialized without gas fees map.")
    }

    this.wallet = wallet
  }
}

namespace TradeHubSDK {
  export import RPCParams = _RPCParams;
  export import RestResponse = _RestResponse;

  export import Network = _Network;
}

export default TradeHubSDK
