'use strict';

import {
	window,
	StatusBarAlignment,
	commands,
	workspace,
	ExtensionContext,
	ConfigurationTarget,
	FileType,
	ProgressLocation,
	Range,
	ViewColumn,
	Uri,
	TextDocument,
	Position,
	EventEmitter
} from 'vscode';
import * as jsYaml from 'js-yaml';
import * as path from 'path';
import * as fs from 'fs';
import * as keyTarType from 'keytar';

import { F5TreeProvider } from './treeViewsProviders/hostsTreeProvider';
import { TclTreeProvider } from './treeViewsProviders/tclTreeProvider';
import { AS3TreeProvider } from './treeViewsProviders/as3TreeProvider';
import { ExampleDecsProvider } from './treeViewsProviders/githubDecExamples';
import { FastTemplatesTreeProvider } from './treeViewsProviders/fastTreeProvider';
import { CfgProvider } from './treeViewsProviders/cfgTreeProvider';
import * as f5Api from './utils/f5Api';
// import * as extAPI from './utils/externalAPIs';
import * as utils from './utils/utils';
import { ext, initSettings, loadSettings } from './extensionVariables';
import { FastWebView } from './editorViews/fastWebView';
import * as f5FastApi from './utils/f5FastApi';
import * as f5FastUtils from './utils/f5FastUtils';
import * as rpmMgmt from './utils/rpmMgmt';
// import { MgmtClient } from './utils/f5DeviceClient';
import logger from './utils/logger';
import { deviceImport, deviceImportOnLoad } from './deviceImport';
import { TextDocumentView } from './editorViews/editorView';
import { makeExplosion } from './cfgExplorer';
// import { unInstallOldExtension } from './extMigration';
import { injectSchema } from './atcSchema';
import { ChangeVersion } from './changeVersion';
import { FastCore } from './fastCore';

import { F5Client } from './f5Client';
import { Device } from './models';
import { HttpResponse, isArray, Asset } from 'f5-conx-core';


export async function activate(context: ExtensionContext) {

	process.on('unhandledRejection', error => {
		logger.error('unhandledRejection', error);
	});


	// initialize extension settings
	await initSettings(context);

	// load ext config to ext.settings.
	await loadSettings();

	ext.connectBar = window.createStatusBarItem(StatusBarAlignment.Left, 9);
	ext.connectBar.command = 'f5.connectDevice';
	ext.connectBar.text = 'F5 -> Connect!';
	ext.connectBar.tooltip = 'Click to connect!';
	ext.connectBar.show();

	ext.panel = new TextDocumentView();
	ext.keyTar = keyTarType;






	/**
	 * #########################################################################
	 *
	 * 	     ########  ######## ##     ## ####  ######  ########  ######  
	 *	     ##     ## ##       ##     ##  ##  ##    ## ##       ##    ## 
	 *	     ##     ## ##       ##     ##  ##  ##       ##       ##       
	 *	     ##     ## ######   ##     ##  ##  ##       ######    ######  
	 *	     ##     ## ##        ##   ##   ##  ##       ##             ## 
	 *	     ##     ## ##         ## ##    ##  ##    ## ##       ##    ## 
	 * 	     ########  ########    ###    ####  ######  ########  ######  
	 * 
	 * http://patorjk.com/software/taag/#p=display&h=0&f=Banner3&t=Devices
	 * #########################################################################
	 */


	const hostsTreeProvider = new F5TreeProvider('');
	// window.registerTreeDataProvider('f5Hosts', hostsTreeProvider);
	window.createTreeView('f5Hosts', {
		treeDataProvider: hostsTreeProvider,
		showCollapseAll: true
	});
	commands.registerCommand('f5.refreshHostsTree', () => hostsTreeProvider.refresh());

	context.subscriptions.push(commands.registerCommand('f5.connectDevice', async (device) => {

		logger.info('selected device', device);  // preferred at the moment

		if (ext.f5Client) {
			ext.f5Client.disconnect();
		}

		if (!device) {
			const bigipHosts: Device[] | undefined = await workspace.getConfiguration().get('f5.hosts');

			if (bigipHosts === undefined) {
				throw new Error('no hosts in configuration');
			}

			/**
			 * loop through config array of objects and build quickPick list appropriate labels
			 * [ {label: admin@192.168.1.254:8443, target: { host: 192.168.1.254, user: admin, ...}}, ...]
			 */
			const qPickHostList = bigipHosts.map(item => {
				return { label: item.device, target: item };
			});

			device = await window.showQuickPick(qPickHostList, { placeHolder: 'Select Device' });
			if (!device) {
				throw new Error('user exited device input');
			} else {
				// now that we made it through quickPick drop the label/object wrapper for list and just return device object
				device = device.target;
			}
		}

		var [user, host] = device.device.split('@');
		var [host, port] = host.split(':');

		const password: string = await utils.getPassword(device.device);


		ext.f5Client = new F5Client(device, host, user, password, {
				port,
				provider: device.provider,
			},
			ext.eventEmitterGlobal,
			ext.extHttp);

		await ext.f5Client.connect()
			.then(connect => {

				// cache password in keytar
				ext.keyTar.setPassword('f5Hosts', device.device, password);

				logger.debug('F5 Connect Discovered', connect);
				hostsTreeProvider.refresh();
			})
			.catch(err => {
				logger.error('Connect/Discover failed');
			});
	}));

	context.subscriptions.push(commands.registerCommand('f5.getProvider', async () => {
		ext.f5Client?.https('/mgmt/tm/auth/source')
			.then(resp => ext.panel.render(resp));
	}));


	context.subscriptions.push(commands.registerCommand('f5.getF5HostInfo', async () => {

		// can can be updated to return the same details collected at discovery
		// var device: string | undefined = ext.hostStatusBar.text;

		// if (!device) {
		// 	device = await commands.executeCommand('f5.connectDevice');
		// }

		// if (device === undefined) {
		// 	throw new Error('no hosts in configuration');
		// }

		if (!ext.f5Client) {
			await commands.executeCommand('f5.connectDevice');
		}

		if (ext.f5Client) {
			await ext.f5Client.https('/mgmt/shared/identified-devices/config/device-info')
				.then(resp => ext.panel.render(resp));
		}

	}));

	context.subscriptions.push(commands.registerCommand('f5.disconnect', () => {


		if (ext.f5Client) {
			ext.f5Client.disconnect();
			ext.f5Client = undefined;
		}
		// refresh host view to clear any dropdown menus
		hostsTreeProvider.refresh();
	}));

	context.subscriptions.push(commands.registerCommand('f5.clearPassword', async (item) => {
		return hostsTreeProvider.clearPassword(item.label);
	}));


	context.subscriptions.push(commands.registerCommand('f5.addHost', async (newHost) => {
		return await hostsTreeProvider.addDevice(newHost);
	}));

	context.subscriptions.push(commands.registerCommand('f5.removeHost', async (hostID) => {
		return await hostsTreeProvider.removeDevice(hostID);
	}));

	context.subscriptions.push(commands.registerCommand('f5.editHost', async (hostID) => {

		logger.debug(`Edit Host command: ${JSON.stringify(hostID)}`);

		let bigipHosts: { device: string }[] | undefined = workspace.getConfiguration().get('f5.hosts');
		logger.debug(`Current bigipHosts: ${JSON.stringify(bigipHosts)}`);

		window.showInputBox({
			prompt: 'Update Device/BIG-IP/Host',
			value: hostID.label,
			ignoreFocusOut: true
		})
			.then(input => {

				logger.debug('user input', input);

				if (input === undefined || bigipHosts === undefined) {
					// throw new Error('Update device inputBox cancelled');
					logger.warn('Update device inputBox cancelled');
					return;
				}

				const deviceRex = /^[\w-.]+@[\w-.]+(:[0-9]+)?$/;
				const devicesString = JSON.stringify(bigipHosts);

				if (!devicesString.includes(`\"${input}\"`) && deviceRex.test(input)) {

					bigipHosts.forEach((item: { device: string; }) => {
						if (item.device === hostID.label) {
							item.device = input;
						}
					});

					workspace.getConfiguration().update('f5.hosts', bigipHosts, ConfigurationTarget.Global);
					setTimeout(() => { hostsTreeProvider.refresh(); }, 300);
				} else {

					window.showErrorMessage('Already exists or invalid format: <user>@<host/ip>:<port>');
				}
			});

	}));



	context.subscriptions.push(commands.registerCommand('f5.editDeviceProvider', async (hostID) => {

		let bigipHosts: { device: string }[] | undefined = workspace.getConfiguration().get('f5.hosts');

		const providerOptions: string[] = [
			'local',
			'radius',
			'tacacs',
			'tmos',
			'active-dirctory',
			'ldap',
			'apm',
			'custom for bigiq'
		];

		window.showQuickPick(providerOptions, { placeHolder: 'Default BIGIP providers' })
			.then(async input => {

				logger.debug('user input', input);

				if (input === undefined || bigipHosts === undefined) {
					// throw new Error('Update device inputBox cancelled');
					logger.warn('Update device inputBox cancelled');
					return;
				}

				if (input === 'custom for bigiq') {
					input = await window.showInputBox({
						prompt: "Input custom bigiq login provider"
					});
				}

				bigipHosts.forEach((item: { device: string; provider?: string; }) => {
					if (item.device === hostID.label) {
						item.provider = input;
					}
				});

				workspace.getConfiguration().update('f5.hosts', bigipHosts, ConfigurationTarget.Global);

				setTimeout(() => { hostsTreeProvider.refresh(); }, 300);
			});

	}));


	context.subscriptions.push(commands.registerCommand('f5.deviceImport', async (item) => {

		// get editor window
		var editor = window.activeTextEditor;
		if (!editor) {
			return; // No open text editor
		}

		// capture selected text or all text in editor
		let text: string;
		if (editor.selection.isEmpty) {
			text = editor.document.getText();	// entire editor/doc window
		} else {
			text = editor.document.getText(editor.selection);	// highlighted text
		}

		await deviceImport(text);

		setTimeout(() => { hostsTreeProvider.refresh(); }, 1000);

	}));



	context.subscriptions.push(commands.registerCommand('f5.createUCS', async () => {
		// create ucs on f5

		return await window.withProgress({
			location: ProgressLocation.SourceControl,
		}, async () => {

			return await ext.f5Client?.ucs.create()
				.then(resp => {
					debugger;

					setTimeout(() => { hostsTreeProvider.refresh(); }, 1000);
					return resp;
				});
		});

	}));

	context.subscriptions.push(commands.registerCommand('f5.downloadUCS', async (filename) => {
		// download ucs from f5

		return await window.withProgress({
			location: ProgressLocation.Window,
		}, async () => {

			// todo:  this ultimatelly doesn't work right now.  It downloads a file, but only the first 1Mb of the file...
			const fUri = Uri.parse(filename);
			const fUri2 = Uri.file(filename);
			// let saveD = await window.showSaveDialog({defaultUri: Uri.parse(filename)});

			const folder = await window.showOpenDialog({
				title: 'Select Folder to Save UCS',
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false
			});
			// fUri.path = fUri.path.replace(/^\//, '');
			const dest = folder ? folder[0].path : ext.cacheDir;

			// debugger;

			return await ext.f5Client?.ucs.download(filename, dest)
			.catch(err => logger.error('download ucs failed:', err));
			// return await ext.f5Client?.download(filename, dest, 'UCS')
		});
	}));



	context.subscriptions.push(commands.registerCommand('f5.openSettings', () => {
		//	open settings window and bring the user to the F5 section
		return commands.executeCommand("workbench.action.openSettings", "f5");
	}));



	/**
	 * ###########################################################################
	 * 
	 * 				RRRRRR     PPPPPP     MM    MM 
	 * 				RR   RR    PP   PP    MMM  MMM 
	 * 				RRRRRR     PPPPPP     MM MM MM 
	 * 				RR  RR     PP         MM    MM 
	 * 				RR   RR    PP         MM    MM 
	 * 
	 * ############################################################################
	 * http://patorjk.com/software/taag/#p=display&h=0&f=Letters&t=FAST
	 */

	context.subscriptions.push(commands.registerCommand('f5.installRPM', async (selectedRPM) => {

		const downloadResponses = [];
		const upLoadResponses = [];
		let rpm: Asset;
		let signature;
		let installed: HttpResponse;


		if (isArray(selectedRPM)) {

			window.withProgress({
				location: ProgressLocation.SourceControl
			}, async () => {

				rpm = selectedRPM.filter((el: Asset) => el.name.endsWith('.rpm'))[0];
				signature = selectedRPM.filter((el: Asset) => el.name.endsWith('.sha256'))[0];

				// setup logic to see what atc service is being installed, and compare that with what might already be installed
				//  work through process for un-installing, then installing new package

				if (rpm) {

					await ext.f5Client?.atc.download(rpm.browser_download_url)
						.then(async resp => {

							// assign rpm name to variable
							downloadResponses.push(resp);
							await new Promise(resolve => { setTimeout(resolve, 1000); });

							await ext.f5Client?.atc.uploadRpm(resp.data.file)
								.then(async uploadResp => {

									await new Promise(resolve => { setTimeout(resolve, 1000); });
									upLoadResponses.push(uploadResp);
									await ext.f5Client?.atc.install(rpm.name)
										.then(resp => installed = resp);
								});
						})
						.catch(err => {

							// todo: setup error logging
							debugger;
						});
				}
				if (signature) {

					await ext.f5Client?.atc.download(rpm.browser_download_url)
						.then(async resp => {
							await ext.f5Client?.atc.uploadRpm(resp.data.file);
						})
						.catch(err => {
							// todo: setup error logging
							debugger;
						});
				}


				if (installed) {
					await new Promise(resolve => { setTimeout(resolve, 500); });
					await ext.f5Client?.connect(); // refresh connect/status bars
					await new Promise(resolve => { setTimeout(resolve, 500); });
					hostsTreeProvider.refresh();
				}
			});
		}
	}));

	context.subscriptions.push(commands.registerCommand('f5.unInstallRPM', async (rpm) => {

		window.withProgress({
			location: ProgressLocation.SourceControl,
		}, async () => {
			// if no rpm sent in from update command
			if (!rpm) {
				// get installed packages
				const installedRPMs = await rpmMgmt.installedRPMs();
				// have user select package
				rpm = await window.showQuickPick(installedRPMs, { placeHolder: 'select rpm to remove' });
			} else {
				// rpm came from new rpm hosts view
				if (rpm.label && rpm.tooltip) {


					await ext.f5Client?.atc.showInstalled()
						.then(async resp => {
							// loop through response, find rpm that matches rpm.label, then uninstall
							const rpmName = resp.data.queryResponse.filter((el: { name: string }) => el.name === rpm.tooltip)[0];
							return await ext.f5Client?.atc.unInstall(rpmName.packageName);

						});



				}

			}

			if (!rpm) {	// return error pop-up if quickPick escaped
				// return window.showWarningMessage('user exited - did not select rpm to un-install');
				logger.info('user exited - did not select rpm to un-install');
			}

			// const status = await rpmMgmt.unInstallRpm(rpm);
			// window.showInformationMessage(`rpm ${rpm} removal ${status}`);
			// debugger;

			// used to pause between uninstalling and installing a new version of the same atc
			//		should probably put this somewhere else
			await new Promise(resolve => { setTimeout(resolve, 10000); });
			await ext.f5Client?.connect(); // refresh connect/status bars
			hostsTreeProvider.refresh();
		});
	}));



	/**
	 * ###########################################################################
	 * 
	 * 				TTTTTTT    CCCCC    LL      
	 * 				  TTT     CC    C   LL      
	 * 				  TTT     CC        LL      
	 * 				  TTT     CC    C   LL      
	 * 				  TTT      CCCCC    LLLLLLL 
	 * 
	 * ############################################################################
	 * http://patorjk.com/software/taag/#p=display&h=0&f=Letters&t=FAST
	 */


	const tclTreeProvider = new TclTreeProvider();
	window.registerTreeDataProvider('as3Tasks', tclTreeProvider);
	commands.registerCommand('f5.refreshTclTree', () => tclTreeProvider.refresh());


	// --- IRULE COMMANDS ---
	context.subscriptions.push(commands.registerCommand('f5-tcl.getRule', async (rule) => {
		return tclTreeProvider.displayRule(rule);
	}));

	context.subscriptions.push(commands.registerCommand('f5-tcl.deleteRule', async (rule) => {
		return tclTreeProvider.deleteRule(rule);
	}));





	// --- IAPP COMMANDS ---
	context.subscriptions.push(commands.registerCommand('f5-tcl.getApp', async (item) => {
		logger.debug('f5-tcl.getApp command: ', item);
		return ext.panel.render(item);
	}));


	context.subscriptions.push(commands.registerCommand('f5-tcl.getTemplate', async (item) => {
		// returns json view of iApp Template
		return ext.panel.render(item);
	}));


	context.subscriptions.push(commands.registerCommand('f5-tcl.getTMPL', async (item) => {
		// gets the original .tmpl output
		const temp = await tclTreeProvider.getTMPL(item);
		tclTreeProvider.displayTMPL(temp);
	}));

	context.subscriptions.push(commands.registerCommand('f5-tcl.iAppRedeploy', async (item) => {
		const temp = await tclTreeProvider.iAppRedeploy(item);
		/**
		 * setup appropriate response
		 * - if no error - nothing
		 * - if error, editor/pop-up to show error
		 */
		// return utils.displayJsonInEditor(item);
	}));

	context.subscriptions.push(commands.registerCommand('f5-tcl.iAppDelete', async (item) => {
		const temp = await tclTreeProvider.iAppDelete(item);
		tclTreeProvider.refresh();
	}));

	context.subscriptions.push(commands.registerCommand('f5-tcl.postTMPL', async (item) => {
		const resp: any = await tclTreeProvider.postTMPL(item);
		window.showInformationMessage(resp);
		return resp;
	}));

	context.subscriptions.push(commands.registerCommand('f5-tcl.deleteTMPL', async (item) => {
		const resp: any = await tclTreeProvider.deleteTMPL(item);
		return resp;
	}));

	context.subscriptions.push(commands.registerCommand('f5-tcl.mergeTCL', async (item) => {
		await tclTreeProvider.mergeTCL(item);
	}));




	/**
	 * ###########################################################################
	 * 
	 *  			FFFFFFF   AAA    SSSSS  TTTTTTT 
	   *  			FF       AAAAA  SS        TTT   
	   *  			FFFF    AA   AA  SSSSS    TTT   
	   *  			FF      AAAAAAA      SS   TTT   
	   *  			FF      AA   AA  SSSSS    TTT   
	 * 
	 * ############################################################################
	 * http://patorjk.com/software/taag/#p=display&h=0&f=Letters&t=FAST
	 */

	// setting up hosts tree
	const fastTreeProvider = new FastTemplatesTreeProvider();
	window.registerTreeDataProvider('fastView', fastTreeProvider);
	commands.registerCommand('f5-fast.refreshTemplates', () => fastTreeProvider.refresh());

	context.subscriptions.push(commands.registerCommand('f5-fast.getInfo', async () => {
		ext.panel.render(ext.f5Client?.fast?.version);
	}));

	context.subscriptions.push(commands.registerCommand('f5-fast.deployApp', async () => {

		// get editor window
		var editor = window.activeTextEditor;
		if (!editor) {
			return; // No open text editor
		}

		// capture selected text or all text in editor
		let text: string;
		if (editor.selection.isEmpty) {
			text = editor.document.getText();	// entire editor/doc window
		} else {
			text = editor.document.getText(editor.selection);	// highlighted text
		}

		// TODO: make this a try sequence to only parse the json once
		let jsonText: object;
		if (utils.isValidJson(text)) {
			jsonText = JSON.parse(text);
		} else {
			window.showWarningMessage(`Not valid json object`);
			return;
		}

		const resp = await f5FastApi.deployFastApp(jsonText);

		ext.panel.render(resp);

		// give a little time to finish before refreshing trees
		await new Promise(resolve => { setTimeout(resolve, 3000); });
		fastTreeProvider.refresh();
		as3Tree.refresh();
	}));


	context.subscriptions.push(commands.registerCommand('f5-fast.getApp', async (tenApp) => {

		await ext.f5Client?.https(`/mgmt/shared/fast/applications/${tenApp}`)
			.then(resp => ext.panel.render(resp))
			.catch(err => logger.error('get fast app failed:', err));
	}));


	context.subscriptions.push(commands.registerCommand('f5-fast.getTask', async (taskId) => {

		// const resp: any = await ext.mgmtClient?.makeRequest(`/mgmt/shared/fast/tasks/${taskId}`);
		// ext.panel.render(resp);

		await ext.f5Client?.https(`/mgmt/shared/fast/tasks/${taskId}`)
			.then(resp => ext.panel.render(resp))
			.catch(err => logger.error('get fast task failed:', err));
	}));


	context.subscriptions.push(commands.registerCommand('f5-fast.getTemplate', async (template) => {

		// const resp: any = await ext.mgmtClient?.makeRequest(`/mgmt/shared/fast/templates/${template}`);
		// ext.panel.render(resp);

		await ext.f5Client?.https(`/mgmt/shared/fast/templates/${template}`)
			.then(resp => ext.panel.render(resp))
			.catch(err => logger.error('get fast task failed:', err));
	}));

	context.subscriptions.push(commands.registerCommand('f5-fast.getTemplateSets', async (set) => {

		// const resp: any = await ext.mgmtClient?.makeRequest(`/mgmt/shared/fast/templatesets/${set}`);
		// ext.panel.render(resp);

		await ext.f5Client?.https(`/mgmt/shared/fast/templatesets/${set}`)
			.then(resp => ext.panel.render(resp))
			.catch(err => logger.error('get fast task failed:', err));
	}));


	context.subscriptions.push(commands.registerCommand('f5-fast.convJson2Mst', async () => {

		// get editor window
		var editor = window.activeTextEditor;
		if (!editor) {
			return; // No open text editor
		}

		// capture selected text or all text in editor
		let text: string;
		if (editor.selection.isEmpty) {
			text = editor.document.getText();	// entire editor/doc window
		} else {
			text = editor.document.getText(editor.selection);	// highlighted text
		}

		logger.debug(JSON.stringify(text));

		if (utils.isValidJson(text)) {

			//TODO:  parse object and find the level for just ADC,
			//		need to remove all the AS3 details since fast will handle that
			// - if it's an object and it contains "class" key and value should be "Tenant"
			utils.displayMstInEditor(JSON.parse(text));
		} else {
			window.showWarningMessage(`not valid json object`);
		}


	}));

	context.subscriptions.push(commands.registerCommand('f5-fast.postTemplate', async (sFile) => {

		let text: string | Buffer;

		if (!sFile) {
			// not right click from explorer view, so gather file details

			// get editor window
			var editor = window.activeTextEditor;
			if (!editor) {
				return; // No open text editor
			}

			// capture selected text or all text in editor
			if (editor.selection.isEmpty) {
				text = editor.document.getText();	// entire editor/doc window
			} else {
				text = editor.document.getText(editor.selection);	// highlighted text
			}
		} else {
			// right click from explorer view, so load file contents
			const fileContents = fs.readFileSync(sFile.fsPath);
			// convert from buffer to string
			text = fileContents.toString('utf8');
		}

		await f5FastUtils.zipPostTemplate(text);

		await new Promise(resolve => { setTimeout(resolve, 1000); });
		fastTreeProvider.refresh();
	}));

	context.subscriptions.push(commands.registerCommand('f5-fast.postTemplateSet', async (sPath) => {

		logger.debug('postTemplateSet selection', sPath);
		let wkspPath;
		let selectedFolder;

		if (!sPath) {
			// didn't get a path passed in from right click, so we have to gather necessary details

			// get list of open workspaces
			const workspaces = workspace.workspaceFolders;
			logger.debug('workspaces', workspaces);

			// if no open workspace...
			if (!workspaces) {
				// Show message to select workspace
				await window.showInformationMessage('See top bar to open a workspace with Fast Templates first');
				// pop up to selecte a workspace
				await window.showWorkspaceFolderPick();
				// return to begining of function to try again
				return commands.executeCommand('f5-fast.postTemplateSet');
			}

			const folder1 = workspace.workspaceFolders![0]!.uri;
			wkspPath = folder1.fsPath;
			const folder2 = await workspace.fs.readDirectory(folder1);

			logger.debug('workspace name', workspace.name);

			/**
			 * having problems typing the workspaces to a list for quick pick
			 * todo: get the following working
			 */
			// let wkspc;
			// if (workspaces.length > 1) {
			// 	// if more than one workspace open, have user select the workspace
			// 	wkspc = await window.showQuickPick(workspaces);
			// } else {
			// 	// else select the first workspace
			// 	wkspc = workspaces[0];
			// }

			let wFolders = [];
			for (const [name, type] of await workspace.fs.readDirectory(folder1)) {

				if (type === FileType.Directory) {
					logger.debug('---directory', name);
					wFolders.push(name);
				}
			};

			// have user select first level folder in workspace
			selectedFolder = await window.showQuickPick(wFolders);

			if (!selectedFolder) {
				// if user "escaped" folder selection window
				return window.showInformationMessage('Must select a Fast Template Set folder');
			}
			logger.debug('workspace path', wkspPath);
			logger.debug('workspace folder', selectedFolder);
			selectedFolder = path.join(wkspPath, selectedFolder);

		} else {
			logger.debug('caught selected path');
			selectedFolder = sPath.fsPath;
		}

		await f5FastUtils.zipPostTempSet(selectedFolder);

		await new Promise(resolve => { setTimeout(resolve, 3000); });
		fastTreeProvider.refresh();
	}));

	context.subscriptions.push(commands.registerCommand('f5-fast.deleteFastApp', async (tenApp) => {

		// var device: string | undefined = ext.hostStatusBar.text;
		// const password = await utils.getPassword(device);
		const resp = await f5FastApi.delTenApp(tenApp.label);
		ext.panel.render(resp);

		// give a little time to finish
		await new Promise(resolve => { setTimeout(resolve, 2000); });
		fastTreeProvider.refresh();
		as3Tree.refresh();
	}));


	context.subscriptions.push(commands.registerCommand('f5-fast.deleteFastTempSet', async (tempSet) => {

		const resp = await f5FastApi.delTempSet(tempSet.label);

		window.showInformationMessage(`Fast Template Set Delete: ${resp.data.message}`);

		// give a little time to finish
		await new Promise(resolve => { setTimeout(resolve, 1000); });
		fastTreeProvider.refresh();
	}));



	const fastPanel = new FastWebView();
	context.subscriptions.push(commands.registerCommand('f5-fast.renderHtmlPreview', async (item) => {

		let text: string = 'empty';
		let title: string = 'Fast Template';

		if (item?.hasOwnProperty('scheme') && item?.scheme === 'file') {
			// right click from explorer view initiation, so load file contents
			const fileContents = fs.readFileSync(item.fsPath);
			// convert from buffer to string
			text = fileContents.toString('utf8');
			// set webPanel name to filename
			title = path.parse(item.fsPath).name;

		} else if (item?.hasOwnProperty('label')) {
			// right click on template from fast view when connected to device
			// - ex.  label: 'goodFastTemplates/app4'

			const resp = await ext.f5Client?.https(`/mgmt/shared/fast/templates/${item.label}`);

			if (resp?.data?.sourceText) {
				text = resp?.data?.sourceText;
			} else {
				// alert that we didn't get the response we were looking for
				logger.error('f5-fast.renderHtmlPreview command tried to get template details from connected device, but did not get the source text we were looking for');
			}


		} else {
			// right-click or commandpalette initiation, so get editor text
			var editor = window.activeTextEditor;
			if (editor) {
				if (editor?.selection?.isEmpty) {
					text = editor.document.getText();	// entire editor/doc window
				} else {
					text = editor.document.getText(editor.selection);	// highlighted text
				}
			}
		}
		fastPanel.render(text);

	}));







	/**
	 * ############################################################################
	 * 
	 * 				  AAA     SSSSS   333333  
	 * 				 AAAAA   SS          3333 
	 * 				AA   AA   SSSSS     3333  
	 * 				AAAAAAA       SS      333 
	 * 				AA   AA   SSSSS   333333  
	 * 
	 * ############################################################################
	 * http://patorjk.com/software/taag/#p=display&h=0&f=Letters&t=AS3
	 */


	// setting up as3 tree
	const as3Tree = new AS3TreeProvider();
	window.registerTreeDataProvider('as3Tenants', as3Tree);
	commands.registerCommand('f5-as3.refreshTenantsTree', () => as3Tree.refresh());

	context.subscriptions.push(commands.registerCommand('f5-as3.getDecs', async (tenant) => {

		if (typeof tenant === 'object') {

			// just a regular as3 declaration object
			ext.panel.render(tenant);

		} else {

			// got a simple tenant name as string with uri parameter,
			// this is typically for extended information
			// so fetch fresh information with param
			// await ext.f5Client?.as3?.getDecs({ tenant })
			await ext.f5Client?.https(`/mgmt/shared/appsvcs/declare/${tenant}`)
				.then((resp: any) => ext.panel.render(resp.data))
				.catch(err => logger.error('get as3 tenant with param failed:', err));
		}
	}));



	context.subscriptions.push(commands.registerCommand('f5-as3.expandedTenant', async (tenant) => {
		commands.executeCommand('f5-as3.getDecs', `${tenant.label}?show=expanded`);
	}));


	context.subscriptions.push(commands.registerCommand('f5-as3.deleteTenant', async (tenant) => {

		await window.withProgress({
			location: ProgressLocation.Notification,
			// location: { viewId: 'as3Tenants'},
			title: `Deleting ${tenant.label} Tenant`
		}, async (progress) => {

			await ext.f5Client?.https(`/mgmt/shared/appsvcs/declare`, {
				method: 'POST',
				data: {
					class: 'AS3',
					declaration: {
						schemaVersion: tenant.command.arguments[0].schemaVersion,
						class: 'ADC',
						target: tenant.command.arguments[0].target,
						[tenant.label]: {
							class: 'Tenant'
						}
// 			await ext.f5Client?.as3?.deleteTenant({
// 				class: 'AS3',
// 				declaration: {
// 					schemaVersion: tenant.command.arguments[0].schemaVersion,
// 					class: 'ADC',
// 					target: tenant.command.arguments[0].target,
// 					[tenant.label]: {
// 						class: 'Tenant'
					}
				}
			})
				// await ext.f5Client?.https(`/mgmt/shared/appsvcs/declare`, {
				// 	method: 'POST',
				// 	data: {
				// 		class: 'AS3',
				// 		declaration: {
				// 			schemaVersion: tenant.command.arguments[0].schemaVersion,
				// 			class: 'ADC',
				// 			target: tenant.command.arguments[0].target,
				// 			[tenant.label]: {
				// 				class: 'Tenant'
				// 			}
				// 		}
				// 	}
				// })
				.then((resp: any) => {

					const resp2 = resp.data.results[0];
					progress.report({ message: `${resp2.code} - ${resp2.message}` });

				})
				.catch(err => {
					progress.report({ message: `${err.message}` });
					// might need to adjust logging depending on the error, but this works for now, or at least the main HTTP responses...
					logger.error('as3 delete tenant failed with:', {
						respStatus: err.response.status,
						respText: err.response.statusText,
						errMessage: err.message,
						errRespData: err.response.data
					});
				});

			// hold the status box for user and let things finish before refresh
			await new Promise(resolve => { setTimeout(resolve, 5000); });
		});

		as3Tree.refresh();

	}));

	context.subscriptions.push(commands.registerCommand('f5-as3.getTask', (id) => {

		window.withProgress({
			location: ProgressLocation.Window,
			// location: { viewId: 'as3Tenants'},
			title: `Getting AS3 Task`
		}, async () => {

			await ext.f5Client?.as3?.getTasks(id)
				.then(resp => ext.panel.render(resp))
				.catch(err => logger.error('as3 get task failed:', err));

		});

	}));

	context.subscriptions.push(commands.registerCommand('f5-as3.postDec', async () => {

		var editor = window.activeTextEditor;
		if (!editor) {
			return; // No open text editor
		}

		let text: string;
		if (editor.selection.isEmpty) {
			text = editor.document.getText();	// entire editor/doc window
		} else {
			text = editor.document.getText(editor.selection);	// highlighted text
		}

		if (!utils.isValidJson(text)) {
			return window.showErrorMessage('Not valid JSON object');
		}

		await window.withProgress({
			// location: { viewId: 'as3Tenants'},
			location: ProgressLocation.Notification,
			title: `Posting AS3 Declaration`
		}, async () => {

			await ext.f5Client?.as3?.postDec(JSON.parse(text))
				.then(resp => {
					ext.panel.render(resp);
					as3Tree.refresh();
				})
				.catch(err => logger.error('as3 post dec failed:', err));

		});


	}));


	context.subscriptions.push(commands.registerCommand('f5.injectSchemaRef', async () => {

		// Get the active text editor
		const editor = window.activeTextEditor;

		if (editor) {
			let text: string;
			const document = editor.document;

			// capture selected text or all text in editor
			if (editor.selection.isEmpty) {
				text = editor.document.getText();	// entire editor/doc window
			} else {
				text = editor.document.getText(editor.selection);	// highlighted text
			}

			const [newText, validDec] = await injectSchema(text);

			// check if modification worked
			if (newText && validDec) {
				editor.edit(edit => {
					const startPosition = new Position(0, 0);
					const endPosition = document.lineAt(document.lineCount - 1).range.end;
					edit.replace(new Range(startPosition, endPosition), JSON.stringify(newText, undefined, 4));
				});
			} else if (newText) {
				editor.edit(edit => {
					const startPosition = new Position(0, 0);
					const endPosition = document.lineAt(document.lineCount - 1).range.end;
					edit.replace(new Range(startPosition, endPosition), newText);
				});
			} else {
				logger.warn('ATC schema inject failed');
			}
		}

	}));







	/**
	 * #########################################################################
	 * 
	 *			 TTTTTTT  SSSSS  	
	 *			   TTT   SS      	
	 *			   TTT    SSSSS  	
	 *			   TTT        SS 	
	 *			   TTT    SSSSS  	
	 * 	
	 * http://patorjk.com/software/taag/#p=display&h=0&f=Letters&t=TS
	 * http://patorjk.com/software/taag/#p=display&h=0&f=ANSI%20Regular&t=TS
	 * #########################################################################
	 * 
	 */




	context.subscriptions.push(commands.registerCommand('f5-ts.info', async () => {
		ext.panel.render(ext.f5Client?.ts?.version);
	}));


	context.subscriptions.push(commands.registerCommand('f5-ts.getDec', async () => {
		await window.withProgress({
			location: ProgressLocation.Notification,
			title: `Getting TS Dec`
		}, async () => {

			await ext.f5Client?.https(`/mgmt/shared/telemetry/declare`)
				.then(resp => ext.panel.render(resp))
				.catch(err => logger.error('get ts declaration failed:', err));

		});
	}));

	context.subscriptions.push(commands.registerCommand('f5-ts.postDec', async () => {

		// if selected text, capture that, if not, capture entire document
		var editor = window.activeTextEditor;
		let text: string;
		if (editor) {
			if (editor.selection.isEmpty) {
				text = editor.document.getText();	// entire editor/doc window
			} else {
				text = editor.document.getText(editor.selection);	// highlighted text
			}

			if (!utils.isValidJson(text)) {
				return window.showErrorMessage('Not valid JSON object');
			}
		}

		const progress = await window.withProgress({
			location: ProgressLocation.Notification,
			title: `Posting TS Dec`
		}, async () => {

			await ext.f5Client?.https(`/mgmt/shared/telemetry/declare`, {
				method: 'POST',
				data: JSON.parse(text)
			})
				.then(resp => {
					ext.panel.render(resp);
				})
				.catch(err => {
					ext.panel.render(err);
					logger.error('post ts declaration failed:', err);
				});

		});
	}));

	context.subscriptions.push(commands.registerCommand('f5.getGitHubExample', async (decUrl) => {
		await ext.extHttp.makeRequest({ url: decUrl })
			.then(resp => ext.panel.render(resp))
			.catch(err => logger.error(err));
	}));





	/**
	 * #########################################################################
	 * 
	 * 			 █████    ██████  
	 *			 ██   ██ ██    ██ 
	 *			 ██   ██ ██    ██ 
	 *			 ██   ██ ██    ██ 
	 *			 █████    ██████  
	 * 			
	 * #########################################################################
	 * 	http://patorjk.com/software/taag/#p=display&h=0&f=ANSI%20Regular&t=DO
	 */

	context.subscriptions.push(commands.registerCommand('f5-do.getDec', async () => {

		await window.withProgress({
			location: ProgressLocation.Notification,
			title: `Getting DO Dec`
		}, async () => {
			// const resp: any = await ext.mgmtClient?.makeRequest(`/mgmt/shared/declarative-onboarding/`);
			// ext.panel.render(resp);

			await ext.f5Client?.https(`/mgmt/shared/declarative-onboarding`)
				.then(resp => ext.panel.render(resp))
				.catch(err => logger.error('get do declaration failed:', err));
		});


	}));

	context.subscriptions.push(commands.registerCommand('f5-do.postDec', async () => {

		var editor = window.activeTextEditor;
		if (!editor) {
			return; // No open text editor
		}

		let text: string;
		if (editor.selection.isEmpty) {
			text = editor.document.getText();	// entire editor/doc window
		} else {
			text = editor.document.getText(editor.selection);	// highlighted text
		}

		if (!utils.isValidJson(text)) {
			return window.showErrorMessage('Not valid JSON object');
		}

		const resp = await f5Api.postDoDec(JSON.parse(text));
		ext.panel.render(resp);
	}));


	context.subscriptions.push(commands.registerCommand('f5-do.inspect', async () => {

		await window.withProgress({
			location: ProgressLocation.Notification,
			title: `Getting DO Inspect`
		}, async () => {

			// const resp: any = await ext.mgmtClient?.makeRequest(`/mgmt/shared/declarative-onboarding/inspect`);
			// ext.panel.render(resp);

			await ext.f5Client?.https(`/mgmt/shared/declarative-onboarding/inspect`)
				.then(resp => ext.panel.render(resp))
				.catch(err => logger.error('get do inspect failed:', err));

		});

	}));



	context.subscriptions.push(commands.registerCommand('f5-do.getTasks', async () => {

		await window.withProgress({
			location: ProgressLocation.Notification,
			title: `Getting DO Tasks`
		}, async () => {
			// const resp: any = await ext.mgmtClient?.makeRequest(`/mgmt/shared/declarative-onboarding/task`);
			// ext.panel.render(resp);

			await ext.f5Client?.https(`/mgmt/shared/declarative-onboarding/task`)
				.then(resp => ext.panel.render(resp))
				.catch(err => logger.error('get do tasks failed:', err));
		});
	}));





	/**
	 * #########################################################################
	 * 
	 * 		UU   UU  TTTTTTT  IIIII  LL      
	 * 		UU   UU    TTT     III   LL      
	 * 		UU   UU    TTT     III   LL      
	 * 		UU   UU    TTT     III   LL      
	 * 		 UUUUU     TTT    IIIII  LLLLLLL 
	 * 
	 * #########################################################################
	 * http://patorjk.com/software/taag/#p=display&h=0&f=Letters&t=UTIL
	 */


	// register example delarations tree
	window.registerTreeDataProvider('decExamples', new ExampleDecsProvider());


	// /**
	//  * 
	//  * 
	//  * ###################################################################
	//  * ###################################################################
	//  * ###################################################################
	//  * ###################################################################
	//  * ###################################################################
	//  * 
	//  * 
	//  */

	const cfgProvider = new CfgProvider();
	// const cfgView = window.registerTreeDataProvider('cfgTree', cfgProvider);
	const cfgView = window.createTreeView('cfgTree', { treeDataProvider: cfgProvider, showCollapseAll: true, canSelectMany: true });

	context.subscriptions.push(commands.registerCommand('f5.cfgExploreOnConnect', async (item) => {

		/**
		 * now to ready the archive contents and feed to corkscrew...
		 * 
		 * https://stackoverflow.com/questions/39705209/node-js-read-a-file-in-a-zip-without-unzipping-it
		 * 
		 * Thinking this is all best to handle in corkscrew so it can handle
		 * 	any file type we specify, bigip.conf as string, bigip.conf as single file,
		 * 	UCS arcive, qkview, or our special little archive from above
		 * 
		 */

// 		if (!ext.mgmtClient) {
// 			/**
// 			 * loop this back into the connect flow, since we have the device, automatically connect
// 			 *  - this should probably happen in the main extension.ts
// 			 */
// 			// await commands.executeCommand('f5.connectDevice', item.label);
// 			return window.showWarningMessage('Connect to BIGIP Device first');
// 		}

// 		const file = await getMiniUcs();
// 		let expl: any = undefined;

// 		if (file) {
// 			logger.debug('Got mini_ucs -> extracting config with corkscrew');

// 			expl = await makeExplosion(file);

// 			if (expl) {
// 				await cfgProvider.explodeConfig(expl.explosion);

// 				// inject the config files (not included in explosion output by default)
// 				// cfgProvider.bigipConfs = expl.config;
// 				// inject the config object (just for looks...)
// 				cfgProvider.confObj = expl.obj;
// 			}


// 			try {
// 				// wait  couple seconds before we try to delete the mini_ucs
// 				setTimeout(() => { fs.unlinkSync(file); }, 2000);
// 			} catch (e) {
// 				logger.error('Not able to delete mini_ucs at:', file);
// 			}
// 		} else {
// 			logger.error('Failed to retrieve mini_ucs for configuration exploration');
		if (!ext.f5Client) {
			await commands.executeCommand('f5.connectDevice', item.command.arguments[0]);
		}

		// return await ext.f5Client?.ucs?.
		return await ext.f5Client?.ucs?.get({ mini: true, localDestPathFile: ext.cacheDir })
			.then(async resp => {
				logger.debug('Got mini_ucs -> extracting config with corkscrew');

				return await makeExplosion(resp.data.file)
					.then(async cfg => {
						// return await cfgProvider.explodeConfig(cfg.config, cfg.obj, cfg.explosion);
					})
					.finally(() => {

						logger.debug('Deleting mini_ucs file at', resp.data.file);

						try {
							// wait  couple seconds before we try to delete the mini_ucs
							setTimeout(() => { fs.unlinkSync(resp.data.file); }, 2000);
						} catch (e) {
							logger.error('Not able to delete mini_ucs at:', resp.data.file);
						}
					});
			});

		cfgProvider.refresh();	// refresh with the new information
	}));

	/**
	 * this command is exposed via right click in editor so user does not have to connect to F5
	 * this flow assumes the file is local
	 */
	context.subscriptions.push(commands.registerCommand('f5.cfgExplore', async (item) => {

		let filePath: string;

		if (!item) {
			// no input means we need to browse for a local file
			item = await window.showOpenDialog({
				canSelectMany: false
			});

			// if we got a file from the showOpenDialog, it comes in an array, even though we told it to only allow single item selection -> return the single array item
			if (Array.isArray(item)) {
				item = item[0];
			}
		}

		if (item?._fsPath) {

			logger.info(`f5.cfgExplore _fsPath recieved:`, item._fsPath);
			filePath = item._fsPath;
			
		} else if (item?.path) {
			
			logger.info(`f5.cfgExplore path revieved:`, item.path);
			filePath = item.path;

		} else {

			return logger.error('f5.cfgExplore -> Neither path supplied was valid', JSON.stringify(item));

		}

		try {
			// test that we can access the file
			const x = fs.statSync(filePath);
		} catch (e) {
			// if we couldn't get to the file, trim leading character
			// remove leading slash -> i think this is a bug like:  https://github.com/microsoft/vscode-remote-release/issues/1583
			// filePath = filePath.replace(/^(\\|\/)/, '');
			logger.info(`could not find file with supplied path of ${filePath}, triming leading character`);
			filePath = filePath.substr(1);
		}
		
		
		
		logger.info(`f5.cfgExplore: exploding config @ ${filePath}`);

		await makeExplosion(filePath)
			.then(async expl => {

				if (expl.explosion) {
					await cfgProvider.explodeConfig(expl.explosion);
				}

				if (expl.obj) {
					// inject the config object (just for looks...)
					cfgProvider.confObj = expl.obj;
				}
				cfgProvider.refresh();	// refresh with the new information
			})
			.catch(err => {
				logger.error('cfgExplorer error', err);
			});

	}));


	context.subscriptions.push(commands.registerCommand('f5.cfgExploreRawCorkscrew', async (text) => {
		// no input means we need to browse for a local file
		const file = await window.showOpenDialog({
			canSelectMany: false
		}).then(x => {
			if (Array.isArray(x)) {
				return x[0];
			}
		});

		let filePath;

		if (file?.fsPath) {

			logger.info(`f5.cfgExploreRawCorkscrew _fsPath recieved:`, file.fsPath);
			filePath = file.fsPath;
			
		} else if (file?.path) {
			
			logger.info(`f5.cfgExploreRawCorkscrew path revieved:`, file.path);
			filePath = file.path;

		} else {

			return logger.error('f5.cfgExploreRawCorkscrew -> Neither path supplied was valid', JSON.stringify(file));

		}

		try {
			// test that we can access the file
			const x = fs.statSync(filePath);
		} catch (e) {
			// if we couldn't get to the file, trim leading character
			// remove leading slash -> i think this is a bug like:  https://github.com/microsoft/vscode-remote-release/issues/1583
			// filePath = filePath.replace(/^(\\|\/)/, '');
			logger.info(`could not find file with supplied path of ${filePath}, triming leading character`);
			filePath = filePath.substr(1);
		}

		if (filePath) {
			try {
				const read = fs.readFileSync(filePath, 'utf-8');
				// parse json
				const read2 = JSON.parse(read);
				await cfgProvider.explodeConfig(read2);
			} catch (e) {
				logger.error('cfgExploreRawCorkscrew import failed', e);
			}
		}

		cfgProvider.refresh();	// refresh with the new information
	}));



	context.subscriptions.push(commands.registerCommand('f5.cfgExploreReveal', async (text) => {
		// await new Promise(resolve => { setTimeout(resolve, 2000); });
		if (cfgProvider.viewElement) {
			cfgView.reveal(cfgProvider.viewElement, {
				select: true,
				focus: true,
				expand: true
			});
		}
	}));



	context.subscriptions.push(commands.registerCommand('f5.cfgExploreClear', async (text) => {
		cfgProvider.clear();
	}));

	context.subscriptions.push(commands.registerCommand('f5.cfgExploreRefresh', async (text) => {
		cfgProvider.refresh();
	}));

	context.subscriptions.push(commands.registerCommand('f5.cfgExplore-show', async (text) => {
		const x = cfgView.selection;
		let full: string[] = [];
		// let text2;
		if (Array.isArray(x) && x.length > 1) {
			// got multi-select array, push all necessary details to a single object

			x.forEach((el) => {
				const y = el.command?.arguments;
				if (y) {
					full.push(y[0].join('\n'));
					full.push('\n\n#############################################\n\n');
				}
			});
			text = full;

			// } else if (Array.isArray(x) && x.length === 1) {
			// 	return window.showWarningMessage('Select multiple apps with "Control" key');
		} else if (typeof text === 'string') {
			// just text, convert to single array with render
			text = [text];
		}

		// todo: add logic to catch single right click

		cfgProvider.render(text);
	}));


	// /**
	//  * 
	//  * 
	//  * ###################################################################
	//  * ###################################################################
	//  * ###################################################################
	//  * ###################################################################
	//  * ###################################################################
	//  * 
	//  * 
	//  */

	context.subscriptions.push(commands.registerCommand('f5.jsonYmlConvert', async () => {
		const editor = window.activeTextEditor;
		if (!editor) {
			return;
		}
		const selection = editor.selection;
		const text = editor.document.getText(editor.selection);	// highlighted text


		let newText: string;
		if (utils.isValidJson(text)) {
			logger.debug('converting json -> yaml');
			// since it was valid json -> dump it to yaml
			newText = jsYaml.safeDump(JSON.parse(text), { indent: 4 });
		} else {
			logger.debug('converting yaml -> json');
			newText = JSON.stringify(jsYaml.safeLoad(text), undefined, 4);
		}

		editor.edit(editBuilder => {
			editBuilder.replace(selection, newText);
		});
	}));

	/**
	 * refactor the json<->yaml/base64-encode/decode stuff to follow the following logic
	 * based off of the vscode-extension-examples document-editing-sample
	 */
	// let disposable = commands.registerCommand('extension.reverseWord', function () {
	// 	// Get the active text editor
	// 	let editor = window.activeTextEditor;

	// 	if (editor) {
	// 		let document = editor.document;
	// 		let selection = editor.selection;

	// 		// Get the word within the selection
	// 		let word = document.getText(selection);
	// 		let reversed = word.split('').reverse().join('');
	// 		editor.edit(editBuilder => {
	// 			editBuilder.replace(selection, reversed);
	// 		});
	// 	}
	// });

	context.subscriptions.push(commands.registerCommand('f5.b64Encode', () => {
		const editor = window.activeTextEditor;
		if (!editor) {
			return;
		}
		const text = editor.document.getText(editor.selection);	// highlighted text
		const encoded = Buffer.from(text).toString('base64');
		editor.edit(editBuilder => {
			editBuilder.replace(editor.selection, encoded);
		});
	}));


	context.subscriptions.push(commands.registerCommand('f5.b64Decode', () => {
		const editor = window.activeTextEditor;
		if (!editor) {
			return;
		}
		const text = editor.document.getText(editor.selection);	// highlighted text
		const decoded = Buffer.from(text, 'base64').toString('ascii');
		editor.edit(editBuilder => {
			editBuilder.replace(editor.selection, decoded);
		});
	}));


	context.subscriptions.push(commands.registerCommand('f5.makeRequest', async () => {
		/**
		 * make open/raw https call
		 * 
		 */

		logger.debug('executing f5.makeRequest');
		const editor = window.activeTextEditor;
		let resp;

		if (editor) {
			var text: any = editor.document.getText(editor.selection);	// highlighted text

			// see if it's json or yaml or string
			if (utils.isValidJson(text)) {

				logger.debug('JSON detected -> parsing');
				text = JSON.parse(text);

			} else {

				logger.debug('NOT JSON');

				if (text.includes('url:')) {
					// if yaml should have url: param
					logger.debug('yaml with url: param -> parsing raw to JSON', JSON.stringify(text));
					text = jsYaml.safeLoad(text);

				} else {
					// not yaml
					logger.debug('http with OUT url param -> converting to json');
					// trim line breaks
					text = text.replace(/(\r\n|\n|\r)/gm, "");
					text = { url: text };
				}
			}

			/**
			 * At this point we should have a json object with parameters
			 * 	depending on the parameters, it's an F5 call, or an external call
			 */

			if (text.url.includes('http')) {

				resp = await window.withProgress({
					location: ProgressLocation.Notification,
					title: `Making External API Request`,
					cancellable: true
				}, async (progress, token) => {
					token.onCancellationRequested(() => {
						// this logs but doesn't actually cancel...
						logger.debug("User canceled External API Request");
						return new Error(`User canceled External API Request`);
					});

					//external call
					logger.debug('external call -> ', JSON.stringify(text));
					// return await extAPI.makeRequest(text);

					return await ext.extHttp.makeRequest(text);

				});

			} else {

				resp = await window.withProgress({
					location: ProgressLocation.Notification,
					title: `Making API Request`,
					cancellable: true
				}, async (progress, token) => {
					token.onCancellationRequested(() => {
						// this logs but doesn't actually cancel...
						logger.debug("User canceled API Request");
						return new Error(`User canceled API Request`);
					});

					// f5 device call
					if (!ext.f5Client) {
						// connect to f5 if not already connected
						await commands.executeCommand('f5.connectDevice');
					}

					logger.debug('generic https f5 call -> ', text);
					return await ext.f5Client?.https(text.url, {
						method: text.method,
						data: text.body
					})
						.then(resp => resp)
						.catch(err => logger.error('Generic rest call to connected device failed:', err));
				});
			}

			if (resp) {
				ext.panel.render(resp);
			}
		}

	}));


	context.subscriptions.push(commands.registerCommand('f5.remoteCommand', async () => {

		const cmd = await window.showInputBox({ placeHolder: 'Bash Command to Execute?', ignoreFocusOut: true });

		if (cmd === undefined) {
			// maybe just showInformationMessage and exit instead of error?
			throw new Error('Remote Command inputBox cancelled');
		}

		// const resp: any = await ext.mgmtClient?.makeRequest(`/mgmt/tm/util/bash`, {
		// 	method: 'POST',
		// 	body: {
		// 		command: 'run',
		// 		utilCmdArgs: `-c '${cmd}'`
		// 	}
		// });

		// ext.panel.render(resp.data.commandResult);


		await ext.f5Client?.https(`/mgmt/tm/util/bash`, {
			method: 'POST',
			data: {
				command: 'run',
				utilCmdArgs: `-c '${cmd}'`
			}
		})
			.then(resp => ext.panel.render(resp.data.commandResult))
			.catch(err => logger.error('bash command failed:', err));
	}));


	// context.subscriptions.push(commands.registerCommand('chuckJoke', async () => {


	// 	const newEditorColumn = ext.settings.previewColumn;
	// 	const wndw = window.visibleTextEditors;
	// 	let viewColumn: ViewColumn | undefined;

// <<<<<<< main
// 		const newEditorColumn = ext.settings.previewColumn;
// 		const wndw = window.visibleTextEditors;
// 		let viewColumn: ViewColumn | undefined;

// 		wndw.forEach(el => {
// 			// const el1 = element;
// 			if (el.document.fileName === 'chuck-joke.json') {
// 				//logger.debug('f5-fast.json editor column', el1.viewColumn);
// 				viewColumn = el.viewColumn;
// 			}
// 		});


// 		const resp: any = await extAPI.makeRequest({ url: 'https://api.chucknorris.io/jokes/random' });
// 		// let activeColumn = window.activeTextEditor?.viewColumn;

// 		logger.debug('chuck-joke->resp.data', resp.data);

// 		const content = JSON.stringify(resp.data, undefined, 4);

// 		// if vClm has a value assign it, else set column 1
// 		viewColumn = viewColumn ? viewColumn : newEditorColumn;

// 		var vDoc: Uri = Uri.parse("untitled:" + "chuck-Joke.json");
// 		workspace.openTextDocument(vDoc)
// 			.then((a: TextDocument) => {
// 				window.showTextDocument(a, viewColumn, false).then(e => {
// 					e.edit(edit => {
// 						const startPosition = new Position(0, 0);
// 						const endPosition = a.lineAt(a.lineCount - 1).range.end;
// 						edit.replace(new Range(startPosition, endPosition), content);
// 					});
// 				});
// 			});
// =======
	// 	wndw.forEach(el => {
	// 		// const el1 = element;
	// 		if (el.document.fileName === 'chuck-joke.json') {
	// 			//logger.debug('f5-fast.json editor column', el1.viewColumn);
	// 			viewColumn = el.viewColumn;
	// 		}
	// 	});
//  >>>>>>> v3.0


	// 	const resp: any = await extAPI.makeRequest({ url: 'https://api.chucknorris.io/jokes/random' });
	// 	// let activeColumn = window.activeTextEditor?.viewColumn;

	// 	logger.debug('chuck-joke->resp.data', resp.data);

	// 	const content = JSON.stringify(resp.data, undefined, 4);

	// 	// if vClm has a value assign it, else set column 1
	// 	viewColumn = viewColumn ? viewColumn : newEditorColumn;

	// 	var vDoc: Uri = Uri.parse("untitled:" + "chuck-Joke.json");
	// 	workspace.openTextDocument(vDoc)
	// 		.then((a: TextDocument) => {
	// 			window.showTextDocument(a, viewColumn, false).then(e => {
	// 				e.edit(edit => {
	// 					const startPosition = new Position(0, 0);
	// 					const endPosition = a.lineAt(a.lineCount - 1).range.end;
	// 					edit.replace(new Range(startPosition, endPosition), content);
	// 				});
	// 			});
	// 		});


	// 	// chuckJoke1();

	// }));

	deviceImportOnLoad(context.extensionPath, hostsTreeProvider);
	// setTimeout( () => { hostsTreeProvider.refresh();}, 1000);

}


// this method is called when your extension is deactivated
export function deactivate() { }
