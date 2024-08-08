import { Middleware } from 'polka';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProviderClass } from "@builderbot/bot";
import { BotContext, GlobalVendorArgs, SendOptions } from "@builderbot/bot/dist/types";
import { MessengerEvents } from "./events";
import axios, { AxiosResponse } from 'axios';
import FormData from 'form-data';
import mime from 'mime-types';

const MESSENGER_API_URL = 'https://graph.facebook.com/';

export type MessengerArgs = GlobalVendorArgs & { accessToken: string, pageId: string, version: string };

export class MessengerProvider extends ProviderClass<MessengerEvents> {
    globalVendorArgs: MessengerArgs = {
        name: 'messenger-bot',
        port: 3000,
        accessToken: undefined,
        pageId: undefined,
        version: 'v19.0',
        verifyToken: undefined
    };

    constructor(args?: MessengerArgs) {
        super();
        this.globalVendorArgs = { ...this.globalVendorArgs, ...args };
        if (!this.globalVendorArgs.accessToken) {
            throw new Error('Must provide Facebook Page Access Token');
        }
        if (!this.globalVendorArgs.pageId) {
            throw new Error('Must provide Facebook Page ID');
        }
        if (!this.globalVendorArgs.verifyToken) {
            throw new Error('Must provide Messenger Verify Token');
        }
    }

    protected async initVendor(): Promise<any> {
        const vendor = new MessengerEvents();
        this.vendor = vendor;
        this.server = this.server
            .post('/webhook', this.ctrlInMsg)
            .get('/webhook', this.ctrlVerify);

        await this.checkStatus();
        return vendor;
    }

    protected beforeHttpServerInit(): void { }

    protected afterHttpServerInit(): void { }

    protected busEvents = (): { event: string; func: Function; }[] => {
        return [
            {
                event: 'auth_failure',
                func: (payload: any) => this.emit('auth_failure', payload),
            },
            {
                event: 'ready',
                func: () => this.emit('ready', true),
            },
            {
                event: 'message',
                func: (payload: BotContext) => {
                    this.emit('message', payload);
                },
            }
        ];
    }

    private async downloadFile(mediaUrl: string): Promise<{ buffer: Buffer; extension: string }> {
        try {
            const response: AxiosResponse = await axios.get(mediaUrl, {
                headers: {
                    Authorization: `Bearer ${this.globalVendorArgs.accessToken}`,
                },
                responseType: 'arraybuffer',
            });
            const contentType = response.headers['content-type'];
            const ext = mime.extension(contentType);
            if (!ext) throw new Error('Unable to determine file extension');
            return {
                buffer: response.data,
                extension: ext,
            };
        } catch (error) {
            console.error(error.message);
            throw error;
        }
    }

    protected ctrlInMsg: Middleware = (req, res) => {
        this.vendor.eventInMsg(req.body);
        return res.end('EVENT_RECEIVED');
    }

    protected ctrlVerify: Middleware = (req, res) => {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode && token) {
            if (mode === 'subscribe' && token === this.globalVendorArgs.verifyToken) {
                console.log('Webhook verified');
                return res.end(challenge);
            } else {
                return res.end('ERROR');
            }
        }
        return res.end('ERROR');
    }

    async checkStatus(): Promise<void> {
        try {
            const url = `${MESSENGER_API_URL}${this.globalVendorArgs.version}/${this.globalVendorArgs.pageId}`;
            const response = await axios.get(url, {
                params: {
                    access_token: this.globalVendorArgs.accessToken,
                    fields: 'id,name'
                },
            });
            if (response.status === 200) {
                console.log('Successfully authenticated with Facebook Messenger API');
                this.emit('ready');
            } else {
                console.error('Unexpected response status:', response.status);
                this.emit('auth_failure', {
                    instructions: [
                        'Failed to authenticate with Facebook Messenger API',
                        'Please check your access token and ensure it has the necessary permissions',
                    ],
                });
            }
        } catch (err) {
            console.error('Error checking status:', err.response?.data || err.message);
            this.emit('auth_failure', {
                instructions: [
                    'An error occurred while checking the API status',
                    `Error details: ${err.response?.data?.error?.message || err.message}`,
                    'Please verify your access token and Facebook Page ID',
                ],
            });
        }
    }

    sendMessage = async (userId: string, message: string, options?: SendOptions): Promise<any> => {
        const url = `${MESSENGER_API_URL}${this.globalVendorArgs.version}/me/messages`;
        try {
            const body = {
                recipient: { id: userId },
                message: { text: message },
                access_token: this.globalVendorArgs.accessToken
            };

            const response = await axios.post(url, body);

            console.log('Message sent successfully');
            return response.data;
        } catch (error) {
            console.error('Error sending message:', error.response?.data || error.message);
            throw new Error('Failed to send message');
        }
    }

    async saveFile(ctx: BotContext, options?: { path: string }): Promise<string> {
        if (!ctx?.data?.media?.url) return '';
        try {
            const { buffer, extension } = await this.downloadFile(ctx.data.media.url);
            const fileName = `file-${Date.now()}.${extension}`;
            const pathFile = join(options?.path ?? tmpdir(), fileName);
            await writeFile(pathFile, buffer);
            return pathFile;
        } catch (err) {
            console.error('Error saving file:', err.message);
            return 'ERROR';
        }
    }
}