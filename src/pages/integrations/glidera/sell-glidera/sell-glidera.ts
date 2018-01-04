import { Component } from '@angular/core';
import { NavController, NavParams, Events } from 'ionic-angular';
import { Logger } from '@nsalaun/ng-logger';
import * as _ from 'lodash';

//providers
import { PlatformProvider } from '../../../../providers/platform/platform';
import { PopupProvider } from '../../../../providers/popup/popup';
import { OnGoingProcessProvider } from '../../../../providers/on-going-process/on-going-process';
import { GlideraProvider } from '../../../../providers/glidera/glidera';
import { ProfileProvider } from '../../../../providers/profile/profile';
import { TxFormatProvider } from '../../../../providers/tx-format/tx-format';
import { WalletProvider } from '../../../../providers/wallet/wallet';
import { ConfigProvider } from '../../../../providers/config/config';

@Component({
  selector: 'page-sell-glidera',
  templateUrl: 'sell-glidera.html',
})
export class SellGlideraPage {

  public isCordova: boolean;
  public sendStatus: string;
  public token: string;
  public isFiat: boolean;
  public network: string;
  public wallet: any;
  public wallets: any;
  public amountUnitStr: string;
  public sellInfo: any;

  private currency: string;
  private amount: number;
  private coin: string;

  constructor(
    private platformProvider: PlatformProvider,
    private logger: Logger,
    private popupProvider: PopupProvider,
    private navCtrl: NavController,
    private navParams: NavParams,
    private onGoingProcessProvider: OnGoingProcessProvider,
    private glideraProvider: GlideraProvider,
    private profileProvider: ProfileProvider,
    private txFormatProvider: TxFormatProvider,
    private walletProvider: WalletProvider,
    private configProvider: ConfigProvider,
    private events: Events
  ) {
    this.coin = 'btc';
    this.isCordova = this.platformProvider.isCordova;
  }

  ionViewWillEnter() {

    this.isFiat = this.navParams.data.currency != 'BTC' ? true : false;
    this.amount = this.navParams.data.amountFiat;
    this.currency = this.navParams.data.currency;

    this.network = this.glideraProvider.getNetwork();
    this.wallets = this.profileProvider.getWallets({
      m: 1, // Only 1-signature wallet
      onlyComplete: true,
      network: this.network,
      hasFunds: true,
      coin: this.coin
    });

    if (_.isEmpty(this.wallets)) {
      this.showErrorAndBack('No wallets available');
      return;
    }
    this.onWalletSelect(this.wallets[0]); // Default first wallet
  }

  private showErrorAndBack(err: any): void {
    this.sendStatus = '';
    this.logger.error(err);
    err = err.errors ? err.errors[0].message : err;
    this.popupProvider.ionicAlert('Error', err).then(() => {
      this.navCtrl.pop();
    });
  }

  private showError(err: any): void {
    this.sendStatus = '';
    this.logger.error(err);
    err = err.errors ? err.errors[0].message : err;
    this.popupProvider.ionicAlert('Error', err);
  }

  private statusChangeHandler(processName: string, isOn: boolean): void {
    let showName = this.onGoingProcessProvider.getShowName(processName);
    this.logger.debug('statusChangeHandler: ', processName, showName, isOn);
    if (processName == 'sellingBitcoin' && !isOn) {
      this.sendStatus = 'success';
    } else if (showName) {
      this.sendStatus = showName;
    }
  }

  private processPaymentInfo(): void {
    this.onGoingProcessProvider.set('connectingGlidera', true);
    this.glideraProvider.init((err, data) => {
      if (err) {
        this.onGoingProcessProvider.set('connectingGlidera', false);
        this.showErrorAndBack(err);
        return;
      }
      this.token = data.token;
      let price: any = {};
      if (this.isFiat) {
        price.fiat = this.amount;
      } else {
        price.qty = this.amount;
      }
      this.glideraProvider.sellPrice(this.token, price, (err, sell) => {
        this.onGoingProcessProvider.set('connectingGlidera', false);
        if (err) {
          this.showErrorAndBack(err);
          return;
        }
        this.sellInfo = sell;
      });
    });
  }

  private ask2FaCode(mode, cb): Function {
    if (mode != 'NONE') {
      // SHOW PROMPT
      let title = 'Please, enter the code below';
      let message;
      if (mode == 'PIN') {
        message = 'You have enabled PIN based two-factor authentication.';
      } else if (mode == 'AUTHENTICATOR') {
        message = 'Use an authenticator app (Authy or Google Authenticator).';
      } else {
        message = 'A SMS containing a confirmation code was sent to your phone.';
      }
      this.popupProvider.ionicPrompt(title, message).then((twoFaCode) => {
        if (typeof twoFaCode == 'undefined') return cb();
        return cb(twoFaCode);
      });
    } else {
      return cb();
    }
  }

  public sellConfirm(): void {
    let message = 'Sell bitcoin for ' + this.amount + ' ' + this.currency;
    let okText = 'Confirm';
    let cancelText = 'Cancel';
    this.popupProvider.ionicConfirm(null, message, okText, cancelText).then((ok) => {
      if (!ok) return;
      this.onGoingProcessProvider.set('sellingBitcoin', true);
      this.statusChangeHandler('sellingBitcoin', true)
      this.glideraProvider.get2faCode(this.token, (err, tfa) => {
        if (err) {
          this.onGoingProcessProvider.set('sellingBitcoin', false);
          this.statusChangeHandler('sellingBitcoin', false);
          this.showError(err);
          return;
        }
        this.ask2FaCode(tfa.mode, (twoFaCode) => {
          if (tfa.mode != 'NONE' && _.isEmpty(twoFaCode)) {
            this.onGoingProcessProvider.set('sellingBitcoin', false);
            this.statusChangeHandler('sellingBitcoin', false);
            this.showError('No code entered');
            return;
          }

          let outputs = [];
          let config = this.configProvider.get();
          let configWallet = config.wallet;
          let walletSettings = configWallet.settings;

          this.walletProvider.getAddress(this.wallet, false).then((refundAddress) => {
            if (!refundAddress) {
              this.onGoingProcessProvider.set('sellingBitcoin', false);
              this.statusChangeHandler('sellingBitcoin', false);
              this.showError('Could not create address');
              return;
            }
            this.glideraProvider.getSellAddress(this.token, (err, sellAddress) => {
              if (!sellAddress || err) {
                this.onGoingProcessProvider.set('sellingBitcoin', false);
                this.statusChangeHandler('sellingBitcoin', false);
                this.showError(err);
                return;
              }
              let amount = parseInt((this.sellInfo.qty * 100000000).toFixed(0));
              let comment = 'Glidera transaction';

              outputs.push({
                'toAddress': sellAddress,
                'amount': amount,
                'message': comment
              });

              let txp = {
                toAddress: sellAddress,
                amount: amount,
                outputs: outputs,
                message: comment,
                payProUrl: null,
                excludeUnconfirmedUtxos: configWallet.spendUnconfirmed ? false : true,
                feeLevel: walletSettings.feeLevel || 'normal',
                customData: {
                  'glideraToken': this.token
                }
              };

              this.walletProvider.createTx(this.wallet, txp).then((createdTxp) => {

                this.walletProvider.prepare(this.wallet).then((password) => {

                  this.walletProvider.publishTx(this.wallet, createdTxp).then((publishedTxp) => {

                    this.walletProvider.signTx(this.wallet, publishedTxp, password).then((signedTxp) => {

                      let rawTx = signedTxp.raw;
                      let data = {
                        refundAddress: refundAddress,
                        signedTransaction: rawTx,
                        priceUuid: this.sellInfo.priceUuid,
                        useCurrentPrice: this.sellInfo.priceUuid ? false : true,
                        ip: null
                      };
                      this.glideraProvider.sell(this.token, twoFaCode, data, (err, data) => {
                        this.onGoingProcessProvider.set('sellingBitcoin', false);
                        this.statusChangeHandler('sellingBitcoin', false);
                        if (err) return this.showError(err);
                        this.logger.info(data);
                      });
                    }).catch((err) => {
                      this.onGoingProcessProvider.set('sellingBitcoin', false);
                      this.statusChangeHandler('sellingBitcoin', false);
                      this.showError(err);
                      this.walletProvider.removeTx(this.wallet, publishedTxp).catch((err) => { // TODO in the original code use signedTxp on this function
                        if (err) this.logger.debug(err);
                      });
                    });
                  }).catch((err) => {
                    this.onGoingProcessProvider.set('sellingBitcoin', false);
                    this.statusChangeHandler('sellingBitcoin', false);
                    this.showError(err);
                  });
                }).catch((err) => {
                  this.onGoingProcessProvider.set('sellingBitcoin', false);
                  this.statusChangeHandler('sellingBitcoin', false);
                  this.showError(err);
                });
              }).catch((err) => {
                this.onGoingProcessProvider.set('sellingBitcoin', false);
                this.statusChangeHandler('sellingBitcoin', false);
                this.showError(err);
              });
            });
          });
        });
      });
    });
  }

  public onWalletSelect(wallet): void {
    this.wallet = wallet;
    let parsedAmount = this.txFormatProvider.parseAmount(
      this.coin,
      this.amount,
      this.currency);

    this.amount = parsedAmount.amount;
    this.currency = parsedAmount.currency;
    this.amountUnitStr = parsedAmount.amountUnitStr;
    this.processPaymentInfo();
  }

  public showWallets(): void {
    let id = this.wallet ? this.wallet.credentials.walletId : null;
    this.events.publish('showWalletsSelectorEvent', this.wallets, id, 'Sell From');
    this.events.subscribe('selectWalletEvent', (wallet: any) => {
      this.onWalletSelect(wallet);
      this.events.unsubscribe('selectWalletEvent');
    });
  }

  public goBackHome(): void {
    this.sendStatus = '';
    this.navCtrl.remove(3, 1);
    this.navCtrl.pop();
  }
}