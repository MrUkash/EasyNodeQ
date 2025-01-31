﻿import * as util from 'util';
import * as amqp from 'amqplib';
import * as Promise from 'bluebird';
import * as uuid from 'node-uuid';


export class RabbitHutch {
    public static CreateBus(config: IBusConfig): IBus {
        var bus = new Bus(config);
        return bus;
    }

    public static CreateExtendedBus(config: IBusConfig): IExtendedBus {
        var bus = new ExtendedBus(config);
        return bus;
    }
}

export class Bus implements IBus {

    private static rpcExchange = 'easy_net_q_rpc';
    private static rpcQueueBase = 'easynetq.response.';
    private static defaultErrorQueue = 'EasyNetQ_Default_Error_Queue';
    private static defaultDeferredAckTimeout = 10000;

    private Connection: Promise<any>;
    private rpcQueue = null;
    private rpcConsumerTag: Promise<IQueueConsumeReply>;
    private rpcResponseHandlers = {};

    protected Channels: { publishChannel: any; rpcChannel: any; } = {
        publishChannel: null,
        rpcChannel: null
    }

    private pubChanUp: Promise<boolean>;
    private rpcConsumerUp: Promise<boolean>;

    private static remove$type = (obj, recurse: boolean = true) => {
        try {
            delete obj.$type;
            var o;
            if (recurse) {
                for (o in obj) {
                    if (obj.hasOwnProperty(o) && obj[o] === Object(obj[o])) Bus.remove$type(obj[o]);
                }
            }
        }
        catch (e) {
            console.error('[Bus gulping error: %s]', e.message);
        }
    }

    // TODO: handle error for msg (can't stringify error)
    public SendToErrorQueue(msg: any, err: string = '', stack: string = '') {
        var errMsg = {
            TypeID: 'Common.ErrorMessage:Messages',
            Message: msg === void 0 ? null : JSON.stringify(msg),
            Error: err === void 0 ? null : err,
            Stack: stack === void 0 ? null : stack
        };

        return this.pubChanUp
            .then(() => this.Channels.publishChannel.assertQueue(Bus.defaultErrorQueue, { durable: true, exclusive: false, autoDelete: false }))
            .then(() => this.Send(Bus.defaultErrorQueue, errMsg));
    }

    constructor(public config: IBusConfig) {
        try {
            this.Connection = Promise.resolve(amqp.connect(config.url + (config.vhost !== null ? '/' + config.vhost : '') + '?heartbeat=' + config.heartbeat));

            this.pubChanUp = this.Connection
                .then((connection) => connection.createConfirmChannel())
                .then((confChanReply) => {
                    this.Channels.publishChannel = confChanReply;
                    return true;
                });
        }
        catch (e) {
            console.log('[ERROR] - Connection problem %s', e);
        }
    }

    // ========== Publish / Subscribe ==========
    public Publish(msg: { TypeID: string }, withTopic: string = ''): Promise<boolean> {
        if (typeof msg.TypeID !== 'string' || msg.TypeID.length === 0) {
            return Promise.reject<boolean>(util.format('%s is not a valid TypeID', msg.TypeID));
        }

        return this.pubChanUp
            .then(() => this.Channels.publishChannel.assertExchange(msg.TypeID, 'topic', { durable: true, autoDelete: false }))
            .then((okExchangeReply) => this.Channels.publishChannel.publish(msg.TypeID, withTopic, Bus.ToBuffer(msg), { type: msg.TypeID }));
    }

    public Subscribe(
        type: { TypeID: string },
        subscriberName: string,
        handler: (msg: { TypeID: string }, ackFns?: { ack: () => void; nack: () => void; defer: () => void }) => void,
        withTopic: string = '#'):
        Promise<IConsumerDispose> {
        if (typeof type.TypeID !== 'string' || type.TypeID.length === 0) {
            return Promise.reject(util.format('%s is not a valid TypeID', type.TypeID));
        }

        if (typeof handler !== 'function') {
            return Promise.reject('xyz is not a valid function');
        }

        var queueID = type.TypeID + '_' + subscriberName;

        return this.Connection.then((connection) => {
            return Promise.resolve(connection.createChannel())
                .then((channel) => {
                    channel.prefetch(this.config.prefetch);
                    return channel.assertQueue(queueID, { durable: true, exclusive: false, autoDelete: false })
                        .then(() => channel.assertExchange(type.TypeID, 'topic', { durable: true, autoDelete: false }))
                        .then(() => channel.bindQueue(queueID, type.TypeID, withTopic))
                        .then(() => channel.consume(queueID, (msg: IPublishedObj) => {
                            if (msg) {
                                var _msg = Bus.FromSubscription(msg);

                                if (msg.properties.type === type.TypeID) {
                                    _msg.TypeID = _msg.TypeID || msg.properties.type;  //so we can get non-BusMessage events

                                    let ackdOrNackd = false;
                                    let deferred = false;
                                    let deferTimeout: NodeJS.Timeout;

                                    const ack = () => {
                                        if (deferred) clearTimeout(deferTimeout);
                                        channel.ack(msg);
                                        ackdOrNackd = true;
                                    };

                                    const nack = () => {
                                        if (deferred) clearTimeout(deferTimeout);
                                        if (!msg.fields.redelivered) {
                                            channel.nack(msg);
                                        }
                                        else {
                                            //can only nack once
                                            this.SendToErrorQueue(_msg, "attempted to nack previously nack'd message");
                                        }
                                        ackdOrNackd = true;
                                    };

                                    handler(_msg, {
                                        ack,
                                        nack,
                                        defer: (timeout: number = Bus.defaultDeferredAckTimeout) => {
                                            deferred = true;
                                            deferTimeout = setTimeout(() => {
                                                nack();
                                            }, timeout);
                                        },
                                    });

                                    if (!ackdOrNackd && !deferred) channel.ack(msg);
                                }
                                else {
                                    this.SendToErrorQueue(_msg, util.format('mismatched TypeID: %s !== %s', msg.properties.type, type.TypeID));
                                }
                            }
                        }))
                        .then((ctag) => {
                            return {
                                cancelConsumer: () => {
                                    return channel.cancel(ctag.consumerTag)
                                        .then(() => true)
                                        .catch(() => false);
                                },
                                deleteQueue: () => {
                                    return channel.deleteQueue(queueID)
                                        .then(() => true)
                                        .catch(() => false);
                                },
                                purgeQueue: () => {
                                    return channel.purgeQueue(queueID)
                                        .then(() => true)
                                        .catch(() => false);
                                }
                            }
                        });
                })
        });
    }

    // ========== Send / Receive ==========
    public Send(queue: string, msg: { TypeID: string }): Promise<boolean> {
        if (typeof msg.TypeID !== 'string' || msg.TypeID.length === 0) {
            return Promise.reject<boolean>(util.format('%s is not a valid TypeID', JSON.stringify(msg.TypeID)));
        }

        return this.pubChanUp
            .then(() => this.Channels.publishChannel.sendToQueue(queue, Bus.ToBuffer(msg), { type: msg.TypeID }));
    }

    public Receive(
        rxType: { TypeID: string },
        queue: string,
        handler: (msg: { TypeID: string }, ackFns?: { ack: () => void; nack: () => void; defer: () => void }) => void):
        Promise<IConsumerDispose> {
        var channel = null;

        return this.Connection.then((connection) => {
            return Promise.resolve(connection.createChannel())
                .then((chanReply) => {
                    channel = chanReply;
                    channel.prefetch(this.config.prefetch);
                    return channel.assertQueue(queue, { durable: true, exclusive: false, autoDelete: false });
                })
                .then((okQueueReply) =>
                    channel.consume(queue, (msg) => {
                        if (msg) {
                            var _msg = Bus.FromSubscription(msg);

                            if (msg.properties.type === rxType.TypeID) {
                                _msg.TypeID = _msg.TypeID || msg.properties.type;  //so we can get non-BusMessage events

                                let ackdOrNackd = false;
                                let deferred = false;
                                let deferTimeout: NodeJS.Timeout;

                                const ack = () => {
                                    if (deferred) clearTimeout(deferTimeout);
                                    channel.ack(msg);
                                    ackdOrNackd = true;
                                };

                                const nack = () => {
                                    if (deferred) clearTimeout(deferTimeout);
                                    if (!msg.fields.redelivered) {
                                        channel.nack(msg);
                                    }
                                    else {
                                        //can only nack once
                                        this.SendToErrorQueue(_msg, "attempted to nack previously nack'd message");
                                    }
                                    ackdOrNackd = true;
                                };

                                handler(_msg, {
                                    ack,
                                    nack,
                                    defer: (timeout: number = Bus.defaultDeferredAckTimeout) => {
                                        deferred = true;
                                        deferTimeout = setTimeout(() => {
                                            nack();
                                        }, timeout);
                                    },
                                });

                                if (!ackdOrNackd && !deferred) channel.ack(msg);
                            }
                            else {
                                this.SendToErrorQueue(_msg, util.format('mismatched TypeID: %s !== %s', msg.properties.type, rxType.TypeID))
                            }
                        }
                    })
                        .then((ctag) => {
                            return {
                                cancelConsumer: () => {
                                    return channel.cancel(ctag.consumerTag)
                                        .then(() => true)
                                        .catch(() => false);
                                },
                                deleteQueue: () => {
                                    return channel.deleteQueue(queue)
                                        .then(() => true)
                                        .catch(() => false);
                                },
                                purgeQueue: () => {
                                    return channel.purgeQueue(queue)
                                        .then(() => true)
                                        .catch(() => false);
                                }
                            }
                        })
                );
        });
    }

    public ReceiveTypes(
        queue: string,
        handlers: { rxType: { TypeID: string }; handler: (msg: { TypeID: string }, ackFns?: { ack: () => void; nack: () => void, defer: () => void }) => void }[]):
        Promise<IConsumerDispose> {
        var channel = null;

        return this.Connection.then((connection) => {
            return Promise.resolve(connection.createChannel())
                .then((chanReply) => {
                    channel = chanReply;
                    channel.prefetch(this.config.prefetch);
                    return channel.assertQueue(queue, { durable: true, exclusive: false, autoDelete: false });
                })
                .then((okQueueReply) =>
                    channel.consume(queue, (msg: IPublishedObj) => {
                        var _msg = Bus.FromSubscription(msg);
                        handlers.filter((handler) => handler.rxType.TypeID === msg.properties.type).forEach((handler) => {
                            _msg.TypeID = _msg.TypeID || msg.properties.type;  //so we can get non-BusMessage events

                            let ackdOrNackd = false;
                            let deferred = false;
                            let deferTimeout: NodeJS.Timeout;

                            const ack = () => {
                                if (deferred) clearTimeout(deferTimeout);
                                channel.ack(msg);
                                ackdOrNackd = true;
                            };

                            const nack = () => {
                                if (deferred) clearTimeout(deferTimeout);
                                if (!msg.fields.redelivered) {
                                    channel.nack(msg);
                                }
                                else {
                                    //can only nack once
                                    this.SendToErrorQueue(_msg, "attempted to nack previously nack'd message");
                                }
                                ackdOrNackd = true;
                            };

                            handler.handler(_msg, {
                                ack,
                                nack,
                                defer: (timeout: number = Bus.defaultDeferredAckTimeout) => {
                                    deferred = true;
                                    deferTimeout = setTimeout(() => {
                                        nack();
                                    }, timeout);
                                },
                            });

                            if (!ackdOrNackd && !deferred) channel.ack(msg);
                        });
                    })
                        .then((ctag) => {
                            return {
                                cancelConsumer: () => {
                                    return channel.cancel(ctag.consumerTag)
                                        .then(() => true)
                                        .catch(() => false);
                                },
                                deleteQueue: () => {
                                    return channel.deleteQueue(queue)
                                        .then(() => true)
                                        .catch(() => false);
                                },
                                purgeQueue: () => {
                                    return channel.purgeQueue(queue)
                                        .then(() => true)
                                        .catch(() => false);
                                }
                            }
                        })
                );
        });
    }


    // ========== Request / Response ==========
    public Request(request: { TypeID: string }): Promise<any> {
        let resolver;
        let rejecter;
        var responsePromise = new Promise<any>((resolve, reject) => {
            resolver = resolve;
            rejecter = reject;
        });
        var correlationID = uuid.v4();

        this.rpcResponseHandlers[correlationID] = {
            resolver: resolver,
            rejecter: rejecter,
            timeoutID: setTimeout(() => {
                delete this.rpcResponseHandlers[correlationID];
                throw Error('Timed-out waiting for RPC response, correlationID: ' + correlationID);
            }, this.config.rpcTimeout || 30000)
        }

        this.rpcConsumerUp = this.rpcConsumerUp || this.Connection
            .then((connection) => connection.createChannel())
            .then((channelReply) => {
                this.Channels.rpcChannel = channelReply;
                this.rpcQueue = Bus.rpcQueueBase + uuid.v4();
                return this.Channels.rpcChannel.assertQueue(this.rpcQueue, { durable: false, exclusive: true, autoDelete: true });
            })
            .then((okQueueReply) => {
                return this.Channels.rpcChannel.consume(this.rpcQueue, (msg: IPublishedObj): void => {
                    if (this.rpcResponseHandlers[msg.properties.correlationId]) {
                        this.Channels.rpcChannel.ack(msg);

                        clearTimeout(this.rpcResponseHandlers[msg.properties.correlationId].timeoutID);

                        var _msg = Bus.FromSubscription(msg);
                        _msg.TypeID = _msg.TypeID || msg.properties.type;  //so we can get non-BusMessage events
                        this.rpcResponseHandlers[msg.properties.correlationId].resolver(_msg);
                        delete this.rpcResponseHandlers[msg.properties.correlationId];
                    }
                    else {
                        //ignore it?
                    }
                });
            })
            .then((okSubscribeReply) => {
                this.rpcConsumerTag = okSubscribeReply.consumerTag;
                return true;
            });

        return this.rpcConsumerUp
            .then(() => this.Channels.publishChannel.assertExchange(Bus.rpcExchange, 'direct', { durable: true, autoDelete: false }))
            .then((okExchangeReply) => this.Channels.publishChannel.publish(Bus.rpcExchange, request.TypeID, Bus.ToBuffer(request), { type: request.TypeID, replyTo: this.rpcQueue, correlationId: correlationID }))
            .then((ackd) => responsePromise);
    }

    public Respond(
        rqType: { TypeID: string },
        rsType: { TypeID: string },
        responder: (msg: { TypeID: string }, ackFns?: { ack: () => void; nack: () => void }) => { TypeID: string }):
        Promise<IConsumerDispose> {
        return this.Connection
            .then((connection) => connection.createChannel())
            .then((responseChan) => {
                return responseChan.assertExchange(Bus.rpcExchange, 'direct', { durable: true, autoDelete: false })
                    .then((okExchangeReply) => responseChan.assertQueue(rqType.TypeID, { durable: true, exclusive: false, autoDelete: false }))
                    .then((okQueueReply) => responseChan.bindQueue(rqType.TypeID, Bus.rpcExchange, rqType.TypeID))
                    .then((okBindReply) => responseChan.consume(rqType.TypeID, (reqMsg: IPublishedObj) => {
                        var msg = Bus.FromSubscription(reqMsg);

                        if (reqMsg.properties.type === rqType.TypeID) {
                            msg.TypeID = msg.TypeID || reqMsg.properties.type;  //so we can get non-BusMessage events

                            var replyTo = reqMsg.properties.replyTo;
                            var correlationID = reqMsg.properties.correlationId;

                            var ackdOrNackd = false;

                            var response = responder(msg, {
                                ack: () => {
                                    responseChan.ack(reqMsg);
                                    ackdOrNackd = true;
                                },
                                nack: () => {
                                    if (!reqMsg.fields.redelivered) {
                                        responseChan.nack(reqMsg);
                                    }
                                    else {
                                        //can only nack once
                                        this.SendToErrorQueue(msg, 'attempted to nack previously nack\'d message');
                                    }
                                    ackdOrNackd = true;
                                }
                            });

                            this.Channels.publishChannel.publish('', replyTo, Bus.ToBuffer(response), { type: rsType.TypeID, correlationId: correlationID });
                            if (!ackdOrNackd) responseChan.ack(reqMsg);
                        }
                        else {
                            this.SendToErrorQueue(msg, util.format('mismatched TypeID: %s !== %s', reqMsg.properties.type, rqType.TypeID))
                        }
                    })
                        .then((ctag) => {
                            return {
                                cancelConsumer: () => {
                                    return responseChan.cancel(ctag.consumerTag)
                                        .then(() => true)
                                        .catch(() => false);
                                },
                                deleteQueue: () => {
                                    return responseChan.deleteQueue(rqType.TypeID)
                                        .then(() => true)
                                        .catch(() => false);
                                },
                                purgeQueue: () => {
                                    return responseChan.purgeQueue(rqType.TypeID)
                                        .then(() => true)
                                        .catch(() => false);
                                }
                            }
                        }))
            });
    }

    public RespondAsync(options: {
        rqType: { TypeID: string },
        rsType: { TypeID: string },
        queue?: string,
    },
        responder: (msg: { TypeID: string }, ackFns?: { ack: () => void; nack: () => void }) => Promise<{ TypeID: string }>):
        Promise<IConsumerDispose> {
        if (options.queue === undefined) options.queue = options.rqType.TypeID;
        return this.Connection
            .then((connection) => connection.createChannel())
            .then((responseChan) => {
                return responseChan.assertExchange(Bus.rpcExchange, 'direct', { durable: true, autoDelete: false })
                    .then((okExchangeReply) => responseChan.assertQueue(options.queue, { durable: true, exclusive: false, autoDelete: false }))
                    .then((okQueueReply) => responseChan.bindQueue(options.queue, Bus.rpcExchange, options.queue))
                    .then((okBindReply) => responseChan.consume(options.queue, (reqMsg: IPublishedObj) => {
                        var msg = Bus.FromSubscription(reqMsg);

                        if (reqMsg.properties.type === options.rqType.TypeID) {
                            msg.TypeID = msg.TypeID || reqMsg.properties.type;  //so we can get non-BusMessage events

                            var replyTo = reqMsg.properties.replyTo;
                            var correlationID = reqMsg.properties.correlationId;

                            var ackdOrNackd = false;

                            responder(msg, {
                                ack: () => {
                                    responseChan.ack(reqMsg);
                                    ackdOrNackd = true;
                                },
                                nack: () => {
                                    if (!reqMsg.fields.redelivered) {
                                        responseChan.nack(reqMsg);
                                    }
                                    else {
                                        //can only nack once
                                        this.SendToErrorQueue(msg, 'attempted to nack previously nack\'d message');
                                    }
                                    ackdOrNackd = true;
                                }
                            })
                                .then((response) => {
                                    this.Channels.publishChannel.publish('', replyTo, Bus.ToBuffer(response), { type: options.rsType.TypeID, correlationId: correlationID });
                                    if (!ackdOrNackd) responseChan.ack(reqMsg);
                                });
                        }
                        else {
                            this.SendToErrorQueue(msg, util.format('mismatched TypeID: %s !== %s', reqMsg.properties.type, options.rqType.TypeID))
                        }
                    })
                        .then((ctag) => {
                            return {
                                cancelConsumer: () => {
                                    return responseChan.cancel(ctag.consumerTag)
                                        .then(() => true)
                                        .catch(() => false);
                                },
                                deleteQueue: () => {
                                    return responseChan.deleteQueue(options.queue)
                                        .then(() => true)
                                        .catch(() => false);
                                },
                                purgeQueue: () => {
                                    return responseChan.purgeQueue(options.queue)
                                        .then(() => true)
                                        .catch(() => false);
                                }
                            }
                        }))
            });
    }


    // ========== Etc  ==========
    private static ToBuffer(obj: any): Buffer {
        Bus.remove$type(obj, false);
        return Buffer.from(JSON.stringify(obj));
    }

    private static FromSubscription(obj: IPublishedObj): any {
        //fields: "{"consumerTag":"amq.ctag-QreMJ-zvC07EW2EKtWZhmQ","deliveryTag":1,"redelivered":false,"exchange":"","routingKey":"easynetq.response.0303b47c-2229-4557-9218-30c99c67f8c9"}"
        //props:  "{"headers":{},"deliveryMode":1,"correlationId":"14ac579e-048b-4c30-b909-50841cce3e44","type":"Common.TestMessageRequestAddValueResponse:Findly"}"
        var msg = JSON.parse(obj.content.toString());
        Bus.remove$type(msg);
        return msg;
    }
}

export class ExtendedBus extends Bus implements IExtendedBus {

    constructor(config: IBusConfig) {
        super(config);
    }

    public CancelConsumer(consumerTag: string): Promise<IQueueConsumeReply> {
        return Promise.resolve<IQueueConsumeReply>(this.Channels.publishChannel.cancel(consumerTag));
    }

    public DeleteExchange(exchange: string, ifUnused: boolean = false): void {
        this.Channels.publishChannel.deleteExchange(exchange, { ifUnused: ifUnused });
    }

    public DeleteQueue(queue: string, ifUnused: boolean = false, ifEmpty: boolean = false): Promise<{ messageCount: number }> {
        return Promise.resolve<{ messageCount: number }>(this.Channels.publishChannel.deleteQueue(queue, { ifUnused: ifUnused, ifEmpty: ifEmpty }));
    }

    public DeleteQueueUnconditional(queue: string): Promise<{ messageCount: number }> {
        return Promise.resolve<{ messageCount: number }>(this.Channels.publishChannel.deleteQueue(queue));
    }

    public QueueStatus(queue: string): Promise<{ queue: string; messageCount: number; consumerCount: number; }> {
        return Promise.resolve<{ queue: string; messageCount: number; consumerCount: number; }>(this.Channels.publishChannel.checkQueue(queue));
    }

    public PurgeQueue(queue: string): Promise<IPurgeQueueResponse> {
        return Promise.resolve<IPurgeQueueResponse>(this.Channels.publishChannel.purgeQueue(queue));
    }
}

export interface IBus {
    Publish(msg: { TypeID: string }, withTopic?: string): Promise<boolean>;
    Subscribe(type: { TypeID: string }, subscriberName: string, handler: (msg: { TypeID: string }, ackFns?: { ack: () => void; nack: () => void }) => void, withTopic?: string): Promise<IConsumerDispose>;

    Send(queue: string, msg: { TypeID: string }): Promise<boolean>;
    Receive(rxType: { TypeID: string }, queue: string, handler: (msg: { TypeID: string }, ackFns?: { ack: () => void; nack: () => void }) => void): Promise<IConsumerDispose>;
    ReceiveTypes(queue: string, handlers: { rxType: { TypeID: string }; handler: (msg: { TypeID: string }, ackFns?: { ack: () => void; nack: () => void }) => void }[]): Promise<IConsumerDispose>;

    Request(request: { TypeID: string }): Promise<{ TypeID: string }>;
    Respond(rqType: { TypeID: string }, rsType: { TypeID: string }, responder: (msg: { TypeID: string }, ackFns?: { ack: () => void; nack: () => void }) => { TypeID: string }): Promise<IConsumerDispose>
    RespondAsync(options: {
        rqType: { TypeID: string },
        rsType: { TypeID: string },
        queue?: string,
    }, responder: (msg: { TypeID: string }, ackFns?: { ack: () => void; nack: () => void }) => Promise<{ TypeID: string }>): Promise<IConsumerDispose>

    SendToErrorQueue(msg: any, err?: string, stack?: string): void;
}

export interface IBusConfig {
    heartbeat: number;
    prefetch: number;
    rpcTimeout: number;
    url: string;
    vhost: string;
}

export interface IExtendedBus extends IBus {
    CancelConsumer(consumerTag: string): Promise<IQueueConsumeReply>;
    DeleteExchange(exchange: string, ifUnused: boolean): void;
    DeleteQueue(queue: string, ifUnused: boolean, ifEmpty: boolean): Promise<{ messageCount: number }>;
    DeleteQueueUnconditional(queue: string): Promise<{ messageCount: number }>;
    QueueStatus(queue: string): Promise<{ queue: string; messageCount: number; consumerCount: number; }>;
    PurgeQueue(queue: string): Promise<IPurgeQueueResponse>;
}

interface IPublishedObj {
    content: Buffer;
    fields: any;
    properties: any;
}

export interface IQueueConsumeReply {
    consumerTag: string;
}

export interface IConsumerDispose {
    cancelConsumer: () => Promise<boolean>;
    deleteQueue: () => Promise<boolean>;
    purgeQueue: () => Promise<boolean>;
}

export interface IPurgeQueueResponse {
    messageCount: number;
}
