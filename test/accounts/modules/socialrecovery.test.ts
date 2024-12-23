/**
 * Copyright Clave - All Rights Reserved
 * Unauthorized copying of this file, via any medium is strictly prohibited
 * Proprietary and confidential
 */
import { expect } from 'chai';
import type { ec } from 'elliptic';
import { AbiCoder, HDNodeWallet, parseEther } from 'ethers';
import * as hre from 'hardhat';
import type { Contract } from 'zksync-ethers';
import { Provider, Wallet, utils } from 'zksync-ethers';

import { LOCAL_RICH_WALLETS, getWallet } from '../../../deploy/utils';
import { ClaveDeployer } from '../../utils/deployer';
import { fixture } from '../../utils/fixture';
import { addModule } from '../../utils/managers/modulemanager';
import { VALIDATORS } from '../../utils/names';
import { encodePublicKey, genKey } from '../../utils/p256';
import {
    executeRecovery,
    startSocialRecovery,
    stopRecovery,
    updateSocialRecoveryConfig,
} from '../../utils/recovery/recovery';
import { ethTransfer, prepareTeeTx } from '../../utils/transactions';
import { addR1Validator } from '../../utils/managers/validatormanager';

describe('AGW Contracts - Social Recovery tests', () => {
    let deployer: ClaveDeployer;
    let provider: Provider;
    let richWallet: Wallet;
    let eoaValidator: Contract;
    let teeValidator: Contract;
    let account: Contract;
    let keyPair: ec.KeyPair;
    let wallet: HDNodeWallet;

    let socialRecoveryModule: Contract;

    before(async () => {
        richWallet = getWallet(hre, LOCAL_RICH_WALLETS[0].privateKey);
        deployer = new ClaveDeployer(hre, richWallet);
        provider = new Provider(hre.network.config.url, undefined, {
            cacheTimeout: -1,
        });

        ({ eoaValidator, teeValidator, account, wallet, keyPair } = await fixture(
            deployer,
            VALIDATORS.EOA,
        ));

        const accountAddress = await account.getAddress();

        await deployer.fund(1000, accountAddress);

        await addR1Validator(
            provider,
            account,
            eoaValidator,
            teeValidator,
            wallet,
        );

        socialRecoveryModule = await deployer.deployCustomContract(
            'SocialRecoveryModule',
            ['TEST', '0', 0, 0],
        );
    });

    describe('Module Tests - Social Recovery Module', () => {
        let socialGuardian: Wallet;
        let secondGuardian: Wallet;
        let newKeyPair: ec.KeyPair;

        describe('Adding & Initializing module', () => {
            before(async () => {
                socialGuardian = new Wallet(
                    Wallet.createRandom().privateKey,
                    provider,
                );
                secondGuardian = new Wallet(
                    Wallet.createRandom().privateKey,
                    provider,
                );

                newKeyPair = genKey();
            });

            it('should check existing modules', async () => {
                expect(await account.listModules()).to.deep.eq([]);
            });

            it('should add a new module', async () => {
                expect(
                    await account.isModule(
                        await socialRecoveryModule.getAddress(),
                    ),
                ).to.be.false;

                const initData = AbiCoder.defaultAbiCoder().encode(
                    ['tuple(uint128, uint128, address[])'],
                    [[1, 1, [await socialGuardian.getAddress()]]],
                );
                await addModule(
                    provider,
                    account,
                    eoaValidator,
                    socialRecoveryModule,
                    initData,
                    wallet,
                );
                expect(
                    await account.isModule(
                        await socialRecoveryModule.getAddress(),
                    ),
                ).to.be.true;

                const expectedModules = [
                    await socialRecoveryModule.getAddress(),
                ];
                expect(await account.listModules()).to.deep.eq(expectedModules);
            });

            it('should init the module successfully', async () => {
                const status = await socialRecoveryModule.isInited(
                    await account.getAddress(),
                );
                expect(status).to.eq(true);
            });

            it('should assign the guardian correctly', async () => {
                const guardians = await socialRecoveryModule.getGuardians(
                    await account.getAddress(),
                );
                expect(guardians).to.deep.eq([
                    await socialGuardian.getAddress(),
                ]);
            });

            it('should change the guardian correctly', async () => {
                await updateSocialRecoveryConfig(
                    provider,
                    account,
                    socialRecoveryModule,
                    eoaValidator,
                    [1, 1, [await secondGuardian.getAddress()]],
                    wallet,
                );

                const guardians = await socialRecoveryModule.getGuardians(
                    await account.getAddress(),
                );
                expect(guardians).to.deep.eq([
                    await secondGuardian.getAddress(),
                ]);
            });

            it('should add multiple guardians correctly', async () => {
                await updateSocialRecoveryConfig(
                    provider,
                    account,
                    socialRecoveryModule,
                    eoaValidator,
                    [
                        1,
                        1,
                        [
                            await socialGuardian.getAddress(),
                            await secondGuardian.getAddress(),
                        ],
                    ],
                    wallet,
                );

                const guardians = await socialRecoveryModule.getGuardians(
                    await account.getAddress(),
                );
                expect(guardians).to.deep.eq([
                    await socialGuardian.getAddress(),
                    await secondGuardian.getAddress(),
                ]);
            });
        });

        describe('Recovering account', () => {
            it('should start the recovery process by guardian', async () => {
                const accountAddress = await account.getAddress();

                const isRecoveringBefore =
                    await socialRecoveryModule.isRecovering(accountAddress);
                expect(isRecoveringBefore).to.be.false;

                expect(await account.k1ListOwners()).to.deep.eq([
                    wallet.address
                ]);
                expect(await account.r1ListOwners()).to.deep.eq([]);

                await startSocialRecovery(
                    socialGuardian,
                    account,
                    socialRecoveryModule,
                    newKeyPair,
                );

                const isRecoveringAfter =
                    await socialRecoveryModule.isRecovering(accountAddress);
                expect(isRecoveringAfter).to.be.true;
            });

            it('should decline the social recovery', async () => {
                const accountAddress = await account.getAddress();

                const isRecoveringBefore =
                    await socialRecoveryModule.isRecovering(accountAddress);
                expect(isRecoveringBefore).to.be.true;

                await stopRecovery(
                    provider,
                    account,
                    socialRecoveryModule,
                    eoaValidator,
                    wallet,
                );

                const isRecoveringAfter =
                    await socialRecoveryModule.isRecovering(accountAddress);
                expect(isRecoveringAfter).to.be.false;
            });

            it('should execute the social recovery', async () => {
                const accountAddress = await account.getAddress();

                const isRecoveringBefore =
                    await socialRecoveryModule.isRecovering(accountAddress);
                expect(isRecoveringBefore).to.be.false;

                await startSocialRecovery(
                    socialGuardian,
                    account,
                    socialRecoveryModule,
                    newKeyPair,
                );

                const isRecoveringAfter =
                    await socialRecoveryModule.isRecovering(accountAddress);
                expect(isRecoveringAfter).to.be.true;

                expect(await account.k1ListOwners()).to.deep.eq([
                    wallet.address
                ]);
                expect(await account.r1ListOwners()).to.deep.eq([]);

                await executeRecovery(account, socialRecoveryModule);

                const isRecoveringAfterExecution =
                    await socialRecoveryModule.isRecovering(accountAddress);
                expect(isRecoveringAfterExecution).to.be.false;

                expect(await account.r1ListOwners()).to.deep.eq([
                    encodePublicKey(newKeyPair),
                ]);
                expect(await account.k1ListOwners()).to.deep.eq([]);
            });

            it('should send tx with new keys after recovery', async () => {
                const amount = parseEther('1');
                const richAddress = await richWallet.getAddress();

                const richBalanceBefore = await provider.getBalance(
                    richAddress,
                );

                const txData = ethTransfer(richAddress, amount);
                const tx = await prepareTeeTx(
                    provider,
                    account,
                    txData,
                    await teeValidator.getAddress(),
                    newKeyPair,
                );
                const txReceipt = await provider.broadcastTransaction(
                    utils.serializeEip712(tx),
                );
                await txReceipt.wait();

                const richBalanceAfter = await provider.getBalance(richAddress);

                expect(richBalanceAfter).to.be.equal(
                    richBalanceBefore + amount,
                );
            });
        });
    });
});
