import { Zilliqa } from "@zilliqa-js/zilliqa";
import { Wallet } from "@zilliqa-js/account"
import { APIClient } from "../src/lib/tradehub/api";
import { ApproveZRC2Params, ZILLockParams, ZILClient, ZILClientOpts} from "../src/lib/tradehub/clients/ZILClient";
import { Blockchain, SWTHAddress } from "../src/lib/tradehub/utils";
import { Network, NetworkConfigProvider, NetworkConfigs } from "../src/lib/tradehub/utils/network";
import { getAddressFromPrivateKey } from "@zilliqa-js/crypto";
import BigNumber from "bignumber.js";
import { Token } from "../src/lib/tradehub/models/rest";

async function run() {
    console.log("testing zilliqa client")
    const networkConfigProvider: NetworkConfigProvider = {
        getConfig: function () {
            return NetworkConfigs[Network.DevNet]
        },
    }
    const opts: ZILClientOpts = {
        configProvider: networkConfigProvider,
        blockchain: Blockchain.Zilliqa,
    }
    const client = ZILClient.instance(opts)
    const switcheo = new APIClient(NetworkConfigs.devnet.RestURL)
    console.log(switcheo)

    // const tokens = await client.getExternalBalances(switcheo, "2141bf8b6d2213d4d7204e2ddab92653dc245c5f")
    // console.log(tokens)

    const token: Token = {
      name: 'Zilliqa USDT',
      symbol: 'zUSDT',
      denom: 'zusdt',
      decimals: 12,
      blockchain: 'zil',
      chain_id: 110,
      asset_id: 'ced1f00d5088ef3d246fc622e9b0e5173f2216bf',
      is_active: true,
      is_collateral: false,
      lock_proxy_hash: 'a5484b227f35f5e192e444146a3d9e09f4cdad80',
      delegated_supply: '0',
      originator: 'swth1pacamg4ey0nx6mrhr7qyhfj0g3pw359cnjyv6d' 
    }

    // check allowance
    const allowace = await client.checkAllowanceZRC2(token,"0x2141bf8b6d2213d4d7204e2ddab92653dc245c5f","0xa476fcedc061797fa2a6f80bd9e020a056904298")
    console.log(allowace)
    
    const privateKey = '8c96c599fdb70e6ebdebe9b10473fd7b12b5e8924a724e2b9570436c44eb0ecd'
    const address = getAddressFromPrivateKey(privateKey)


    const zilliqa = new Zilliqa(client.getProviderUrl())
    const wallet  = new Wallet(zilliqa.network.provider)
    wallet.addByPrivateKey(privateKey)

    // approve zrc2 (increase allowance)
    const approveZRC2Params: ApproveZRC2Params = {
        token: token,
        gasPrice: new BigNumber("2000000000"),
        gasLimit: new BigNumber(25000),
        zilAddress: address,
        signer: wallet,
    }
    console.log("approve zrc2 token parameters: ", approveZRC2Params)
    console.log("sending approve transactions")
    const tx = await client.approveZRC2(approveZRC2Params)
    console.log("performing transaction confirmation, transaction id is: ", tx.id)
    await tx.confirm(tx.id)
    console.log("transaction confirmed! receipt is: ", tx.getReceipt())

    // lock deposit
    const lockDepositParams: ZILLockParams = {
        address: SWTHAddress.getAddressBytes("swth1pacamg4ey0nx6mrhr7qyhfj0g3pw359cnjyv6d", Network.DevNet),
        amount: new BigNumber("1000000000000"),
        token: token,
        gasPrice: new BigNumber("2000000000"),
        zilAddress: address,
        gasLimit: new BigNumber(25000),
        signer: wallet,
    }
    console.log("lock deposit parameters: ", lockDepositParams)
    console.log("sending lock deposit transactions")
    // const tx = await client.lockDeposit(lockDepositParams)
    // console.log("performing transaction confirmation, transaction id is: ", tx.id)
    // await tx.confirm(tx.id)
    // console.log("transaction confirmed! receipt is: ", tx.getReceipt())

}

run()