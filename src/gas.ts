import { BlockTag, TransactionReceipt, TransactionRequest } from '@ethersproject/abstract-provider';
import { Networkish } from '@ethersproject/networks';
import { BaseProvider } from '@ethersproject/providers';
import { ConnectionInfo, fetchJson } from '@ethersproject/web';
import { BigNumber, ethers, providers, Signer } from 'ethers';
import { id, keccak256 } from 'ethers/lib/utils';
import { serialize } from '@ethersproject/transactions';

export const DEFAULT_FLASHBOTS_RELAY = 'https://api.sushirelay.com/v1';
export const BASE_FEE_MAX_CHANGE_DENOMINATOR = 8;
const PRIVATE_TX_WAIT_BLOCKS = 25; // # of blocks
type RpcParams = Array<string[] | string | number | Record<string, unknown>>;

export interface FlashbotsGasPricing {
  txCount: number;
  gasUsed: number;
  gasFeesPaidBySearcher: BigNumber;
  priorityFeesReceivedByMiner: BigNumber;
  ethSentToCoinbase: BigNumber;
  effectiveGasPriceToSearcher: BigNumber;
  effectivePriorityFeeToMiner: BigNumber;
}

interface BlocksApiResponseTransactionDetails {
  transaction_hash: string;
  tx_index: number;
  bundle_type: 'rogue' | 'flashbots';
  bundle_index: number;
  block_number: number;
  eoa_address: string;
  to_address: string;
  gas_used: number;
  gas_price: string;
  coinbase_transfer: string;
  total_miner_reward: string;
}

interface BlocksApiResponseBlockDetails {
  block_number: number;
  miner_reward: string;
  miner: string;
  coinbase_transfers: string;
  gas_used: number;
  gas_price: string;
  transactions: Array<BlocksApiResponseTransactionDetails>;
}

export interface BlocksApiResponse {
  latest_block_number: number;
  blocks: Array<BlocksApiResponseBlockDetails>;
}

export class GasProvider extends providers.JsonRpcProvider {
  private genericProvider: BaseProvider;
  private authSigner: Signer;
  private connectionInfo: ConnectionInfo;

  constructor(
    genericProvider: BaseProvider,
    authSigner: Signer,
    connectionInfoOrUrl: ConnectionInfo,
    network: Networkish,
  ) {
    super(connectionInfoOrUrl, network);
    this.genericProvider = genericProvider;
    this.authSigner = authSigner;
    this.connectionInfo = connectionInfoOrUrl;
  }

  static async throttleCallback(): Promise<boolean> {
    console.warn('Rate limited');
    return false;
  }

  /**
   * Calculates maximum base fee in future block.
   * @param baseFee current base fee
   * @param blocksInFuture number of blocks in the future
   */
  static getMaxBaseFeeInFutureBlock(baseFee: BigNumber, blocksInFuture: number): BigNumber {
    let maxBaseFee = BigNumber.from(baseFee);
    for (let i = 0; i < blocksInFuture; i++) {
      maxBaseFee = maxBaseFee.mul(1125).div(1000).add(1);
    }
    return maxBaseFee;
  }

  /**
   * Calculates an optimal base fee for inclusion in the next block.
   * Useful when a bundle is not landing, but simulation is passing.
   * //TODO: Verify my assessment. I'm not sure it's accurate...
   * @param currentBaseFeePerGas base fee of current block (wei)
   * @param currentGasUsed gas used by tx in simulation
   * @param currentGasLimit gas limit of transaction
   * @returns adjusted base fee
   */
  static getBaseFeeInNextBlock(
    currentBaseFeePerGas: BigNumber,
    currentGasUsed: BigNumber,
    currentGasLimit: BigNumber,
  ): BigNumber {
    const currentGasTarget = currentGasLimit.div(2);

    if (currentGasUsed.eq(currentGasTarget)) {
      return currentBaseFeePerGas;
    } else if (currentGasUsed.gt(currentGasTarget)) {
      const gasUsedDelta = currentGasUsed.sub(currentGasTarget);
      const baseFeePerGasDelta = currentBaseFeePerGas
        .mul(gasUsedDelta)
        .div(currentGasTarget)
        .div(BASE_FEE_MAX_CHANGE_DENOMINATOR);

      return currentBaseFeePerGas.add(baseFeePerGasDelta);
    } else {
      const gasUsedDelta = currentGasTarget.sub(currentGasUsed);
      const baseFeePerGasDelta = currentBaseFeePerGas
        .mul(gasUsedDelta)
        .div(currentGasTarget)
        .div(BASE_FEE_MAX_CHANGE_DENOMINATOR);

      return currentBaseFeePerGas.sub(baseFeePerGasDelta);
    }
  }

  public calculateBundlePricing(bundleTransactions: Array<BlocksApiResponseTransactionDetails>, baseFee: BigNumber) {
    const bundleGasPricing = bundleTransactions.reduce(
      (acc, transactionDetail) => {
        const gasUsed = 'gas_used' in transactionDetail ? transactionDetail.gas_used : transactionDetail.gas_used;
        const gasPricePaidBySearcher = BigNumber.from(
          'gas_price' in transactionDetail ? transactionDetail.gas_price : transactionDetail.gas_price,
        );
        const priorityFeeReceivedByMiner = gasPricePaidBySearcher.sub(baseFee);
        const coinbase_transfer =
          'coinbase_transfer' in transactionDetail
            ? transactionDetail.coinbase_transfer
            : 'coinbase_transfer' in transactionDetail
            ? transactionDetail.coinbase_transfer
            : BigNumber.from(0);
        return {
          gasUsed: acc.gasUsed + gasUsed,
          gasFeesPaidBySearcher: acc.gasFeesPaidBySearcher.add(gasPricePaidBySearcher.mul(gasUsed)),
          priorityFeesReceivedByMiner: acc.priorityFeesReceivedByMiner.add(priorityFeeReceivedByMiner.mul(gasUsed)),
          coinbase_transfer: acc.coinbase_transfer.add(coinbase_transfer),
        };
      },
      {
        gasUsed: 0,
        gasFeesPaidBySearcher: BigNumber.from(0),
        priorityFeesReceivedByMiner: BigNumber.from(0),
        coinbase_transfer: BigNumber.from(0),
      },
    );
    const effectiveGasPriceToSearcher =
      bundleGasPricing.gasUsed > 0
        ? bundleGasPricing.coinbase_transfer.add(bundleGasPricing.gasFeesPaidBySearcher).div(bundleGasPricing.gasUsed)
        : BigNumber.from(0);
    const effectivePriorityFeeToMiner =
      bundleGasPricing.gasUsed > 0
        ? bundleGasPricing.coinbase_transfer
            .add(bundleGasPricing.priorityFeesReceivedByMiner)
            .div(bundleGasPricing.gasUsed)
        : BigNumber.from(0);
    return {
      ...bundleGasPricing,
      txCount: bundleTransactions.length,
      effectiveGasPriceToSearcher,
      effectivePriorityFeeToMiner,
    };
  }

  /** Gets information about a block from Flashbots blocks API. */
  public async fetchBlocksApi(blockNumber: number): Promise<BlocksApiResponse> {
    return fetchJson(`https://blocks.flashbots.net/v1/blocks?block_number=${blockNumber}`);
  }

  private async request(request: string) {
    const connectionInfo = { ...this.connectionInfo };
    connectionInfo.headers = {
      'X-Flashbots-Signature': `${await this.authSigner.getAddress()}:${await this.authSigner.signMessage(
        id(request),
      )}`,
      ...this.connectionInfo.headers,
    };
    return fetchJson(connectionInfo, request);
  }

  private prepareRelayRequest(
    method:
      | 'eth_callBundle'
      | 'eth_sendBundle'
      | 'eth_sendPrivateTransaction'
      | 'eth_cancelPrivateTransaction'
      | 'flashbots_getUserStats'
      | 'flashbots_getBundleStats',
    params: RpcParams,
  ) {
    return {
      method: method,
      params: params,
      id: this._nextId++,
      jsonrpc: '2.0',
    };
  }
}
