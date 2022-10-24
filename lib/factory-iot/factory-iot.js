'use strict'
/**
 * Copyright 2021 Appliot,Inc.,
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/
module.exports = function(RED) {
	const fs = require('fs');
	const url = require('url');
	const execSync = require('child_process').execSync;
	const remap_machine = require("./remap_machine");
	const eack = require("./eack");
	const parseMessage = require("./parseMessage");
	const local = require("/home/pi/.appliot/activate/files/config.json");

	const APPLIOT = {
		config : require("/home/pi/.appliot/config.json"),
		access: local.access,
		mqtt:   local.mqtt,
		dbname: local.dbname,
		gwname: local.name,
		gwname: local.name,
		site: local.site,
		db: {}
	};
	let apiServer = url.parse(APPLIOT.config.domain.api);
	const https = require(apiServer.protocol.slice(0,-1));

	function AppliotFactoryIot(config) {
		RED.nodes.createNode(this,config);
		let node = this;

		fs.readFile('/home/pi/.appliot/database/machine.json',(err,data) => {
			if(err) {
				console.log(err);
			} else {
				APPLIOT.db.machine = remap_machine(JSON.parse(data.toString()));
				APPLIOT.eack = eack.init(APPLIOT.db.machine);
				node.send({payload:APPLIOT.eack});
			}
		});
		fs.readFile('/home/pi/.appliot/database/reason.json',(err,data) => {
			if(err) {
				console.log(err);
			} else {
				APPLIOT.db.reason = JSON.parse(data.toString());
			}
		});


		function getDatabase(db,query,done) {
			loop();
			let backoff = 1000;
			function loop() {
				let options = {
					hostname: apiServer.hostname,
					port: apiServer.port,
					path: `/v0/${db}${query}`,
					method: "GET",
					headers: {
						"Content-Type" : "application/json",
						"APPLIOT-API-KEY": APPLIOT.access.key,
						"APPLIOT-API-TOKEN": APPLIOT.access.token,
					}
				}
				let req = https.request(options,(res) => {
					res.setEncoding("utf8");
					let body = "";
					res.on("data",(chunk) => {
						body += chunk;
					});
					res.on("end",() => {
						if(res.statusCode === 200) {
							let data = JSON.parse(body).Items;
							fs.writeFile(`/home/pi/.appliot/database/${db}.json`,JSON.stringify(data),(err) => {
								if(err) {
									console.log(err);
									done(err);
								} else {
									done(null,data);
								}
							});
						} else {
							console.log(body);
							setTimeout(loop,backoff);
							backoff = backoff*2;
							if(backoff > 60000) backoff = 60000;
						}
					});
				});
				req.on("error",(err) => {
					console.log(err);
					setTimeout(loop,backoff);
					backoff = backoff*2;
					if(backoff > 60000) backoff = 60000;
				});
				req.end();
			}
		}
		function getMachine(callback) {
			let query = (APPLIOT.site) ? `?site=${APPLIOT.site}` : "";
			getDatabase("machine",query,(err,data) => {
				if(err) {
					callback(err);
				} else {
					if(config.debug == true) {
						data.forEach((elm) => elm.debug = true);
					}
					APPLIOT.db.machine = remap_machine(data);
					APPLIOT.eack = eack.init(APPLIOT.db.machine);
					node.send({payload:APPLIOT.eack});
					callback(null,{});
				}
			});
		}
		function getReason(callback) {
			getDatabase('reason',"",(err) => {
				if(err) {
					callback(err);
				} else {
					callback(null,{});
				}
			});
		}
		Promise.all([
			new Promise((resolve,reject) => {
				getMachine((err,res) => {
					if(err) {
						reject(err);
					} else {
						resolve();
					}
				});
			}),
			new Promise((resolve,reject) => {
				getReason((err,res) => {
					if(err) {
						reject(err);
					} else {
						resolve();
					}
				});
			})
		]).then(() => {
			console.log("init done");
		}).catch((err) => {
			console.log(err);
		});
		node.on('input', function (msg) {
			let query="";
			if(msg.payload.hasOwnProperty("type")) {
				switch(msg.payload.type) {
					case "machine":
						getMachine((err,res) => {
							if(err) {
								console.log(`fail to update database(${msg.payload.type})`);
								console.log(err);
							} else {
								console.log(`update database(${msg.payload.type})`);
							}
						});
						break;
					case "reason":
						getReason((err,res) => {
							if(err) {
								console.log(`fail to update database(${msg.payload.type})`);
								console.log(err);
							} else {
								console.log(`update database(${msg.payload.type})`);
							}
						});
						break;
				}
			}
		});
	}
	RED.nodes.registerType("appliot-factory-params", AppliotFactoryIot);
	/*
	 * device manager
	 */
	function AppliotDeviceManager(config) {
		RED.nodes.createNode(this,config);
		let node = this;
		node.on('input', function (msg) {
			if(Array.isArray(msg.payload)) {
				for(let i in msg.payload) {
					checkRxData(msg.payload[i]);
				}
			} else {
				checkRxData(msg.payload);
			}
		});
		function checkRxData(rxdata) {
			const payload = rxdata.payload.split(",");
			if(payload[0] === "factory-iot") {
				let message = eack.activate(rxdata,APPLIOT.db.machine,APPLIOT.eack);
				if(message) {
					let timestamp = parseInt(rxdata.sec*1000 + rxdata.nsec/1000000);
					node.send([{
						dst_panid: rxdata.dst_panid,
						dst_addr: rxdata.src_addr,
						payload: message,
					},,{
						topic: `v0/factory-iot/${APPLIOT.dbname}/config/event/machine/${rxdata.machine.id}`,
						payload: {id: rxdata.machine.id,timestamp: timestamp,eventType: "activation",prog_sensor: `${payload[1]}_${payload[2]}`,rssi: rxdata.rssi},
						qos: 1,
					},
						{payload: APPLIOT.eack}]);
				}
				//if(((broadcast === true ) && (payload[0] === "factory-iot")) || ((unicast === true) && (payload[0] === "update"))) {
			} else if(payload[0] === "update") {
				let message = eack.activate(rxdata,APPLIOT.db.machine,APPLIOT.eack);
				if(message) {
					node.send([,{
						dst_panid: rxdata.dst_panid,
						dst_addr: rxdata.src_addr,
						payload: message,
					},,{payload: APPLIOT.eack}]);
				}
			} else {
				let message = parseMessage(rxdata,APPLIOT.db.machine);
				let promise = Promise.resolve();
				for(let m of message) {
					if(rxdata.machine.debug === true) {
						if(rxdata.machine.multi === false) {
							promise.then(() => {
								return new Promise((resolve) => {
									node.send([,,{
										topic: `v0/factory-iot/${APPLIOT.dbname}/config/data/log/${m.id}`,
										payload: m,
										qos: 0,
									}]);
									resolve();
								});
							});
						} else {
							if(rxdata.machine.group.find((elm) => elm.id === m.id).debug === true) {
								promise.then(() => {
									return new Promise((resolve) => {
										node.send([,,{
											topic: `v0/factory-iot/${APPLIOT.dbname}/config/data/log/${m.id}`,
											payload: m,
											qos: 0,
										}]);
										resolve();
									});
								});
							}
						}
					} else {
						promise.then(() => {
							return new Promise((resolve) => {
								const application = (()=>{
									if(!rxdata.machine.multi) {
										return rxdata.machine.application;
									} else {
										return rxdata.machine.group.find((g) => rxdata.machine.addr === g.addr).application;
									}
								})();
								node.send([,,{
									topic: `v0/factory-iot/${APPLIOT.dbname}/${application}/data/latest/${m.id}`,
									payload: m,
									qos: 1,
								}]);
								resolve();
							});
						});
					}
				}
				promise.then(() => {
					node.send([,,,,rxdata]);
				});
			}
		}
	}
	RED.nodes.registerType("appliot-device-manager", AppliotDeviceManager);
}
