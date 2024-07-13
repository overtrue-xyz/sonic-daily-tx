const { readFileSync } = require("fs")
const { Twisters } = require("twisters")
const sol = require("@solana/web3.js")
const bs58 = require("bs58")
const nacl = require("tweetnacl")

require('dotenv').config()

const CAPTCHA_KEY = process.env.CAPTCHA_KEY
const CLAIM_FAUCET = process.env.CLAIM_FAUCET === 'true'
const OPEN_BOX = process.env.OPEN_BOX === 'true'
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_BOT_CHATID = process.env.TELEGRAM_BOT_CHATID
const USE_TELEGRAM_BOT = TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_CHATID

const rpc = 'https://devnet.sonic.game/'
const connection = new sol.Connection(rpc, 'confirmed')
const keypairs = []
const twisters = new Twisters()

let defaultHeaders = {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.7',
    'content-type': 'application/json',
    'priority': 'u=1, i',
    'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Brave";v="126"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'sec-gpc': '1',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
}

function generateRandomAddresses(count) {
    const addresses = []
    for (let i = 0; i < count; i++) {
        const keypair = sol.Keypair.generate()
        addresses.push(keypair.publicKey.toString())
    }
    return addresses
}

function getKeypairFromPrivateKey(privateKey) {
    const decoded = bs58.decode(privateKey)
    return sol.Keypair.fromSecretKey(decoded)
}

const sendTransaction = (transaction, keyPair) => new Promise(async (resolve) => {
    try {
        transaction.partialSign(keyPair)
        const rawTransaction = transaction.serialize()
        const signature = await connection.sendRawTransaction(rawTransaction)
        await connection.confirmTransaction(signature)
        // const hash = await sol.sendAndConfirmTransaction(connection, transaction, [keyPair]);
        resolve(signature)
    } catch (error) {
        resolve(error)
    }
})

const delay = (seconds) => {
    return new Promise((resolve) => {
        return setTimeout(resolve, seconds * 1000)
    })
}

const getLoginToken = (keyPair) => new Promise(async (resolve) => {
    let success = false
    while (!success) {
        try {
            const message = await fetch(`https://odyssey-api-beta.sonic.game/auth/sonic/challenge?wallet=${keyPair.publicKey}`, {
                headers: defaultHeaders
            }).then(res => {
                if (res.status !== 200) {
                    throw new Error(res.statusText)
                }
                return res
            }).then(res => res.json())

            const sign = nacl.sign.detached(Buffer.from(message.data), keyPair.secretKey)
            const signature = Buffer.from(sign).toString('base64')
            const publicKey = keyPair.publicKey.toBase58()
            const addressEncoded = Buffer.from(keyPair.publicKey.toBytes()).toString("base64")
            const authorize = await fetch('https://odyssey-api-beta.sonic.game/auth/sonic/authorize', {
                method: 'POST',
                headers: defaultHeaders,
                body: JSON.stringify({
                    'address': `${publicKey}`,
                    'address_encoded': `${addressEncoded}`,
                    'signature': `${signature}`
                })
            }).then(res => res.json())

            const token = authorize.data.token
            success = true
            resolve(token)
        } catch (e) {
            console.error('Failed to get token, retrying...', e)
        }
    }
})

const dailyCheckin = (keyPair, auth) => new Promise(async (resolve) => {
    let success = false
    while (!success) {
        try {
            const data = await fetch(`https://odyssey-api-beta.sonic.game/user/check-in/transaction`, {
                headers: {
                    ...defaultHeaders,
                    'authorization': `${auth}`
                }
            }).then(res => res.json())

            if (data.message == 'current account already checked in') {
                success = true
                resolve('Already check in today!')
            }

            if (data.data) {
                const transactionBuffer = Buffer.from(data.data.hash, "base64")
                const transaction = sol.Transaction.from(transactionBuffer)
                const signature = await sendTransaction(transaction, keyPair)
                const checkin = await fetch('https://odyssey-api-beta.sonic.game/user/check-in', {
                    method: 'POST',
                    headers: {
                        ...defaultHeaders,
                        'authorization': `${auth}`
                    },
                    body: JSON.stringify({
                        'hash': `${signature}`
                    })
                }).then(res => res.json())

                success = true
                resolve(`Successfully to check in, day ${checkin.data.accumulative_days}!`)
            }
        } catch (e) { }
    }
})

const dailyMilestone = (auth, stage) => new Promise(async (resolve) => {
    let success = false
    while (!success) {
        try {
            await fetch('https://odyssey-api-beta.sonic.game/user/transactions/state/daily', {
                method: 'GET',
                headers: {
                    ...defaultHeaders,
                    'authorization': `${auth}`
                },
            })

            const data = await fetch('https://odyssey-api-beta.sonic.game/user/transactions/rewards/claim', {
                method: 'POST',
                headers: {
                    ...defaultHeaders,
                    'authorization': `${auth}`
                },
                body: JSON.stringify({
                    'stage': stage
                })
            }).then(res => res.json())

            if (data.message == 'interact rewards already claimed') {
                success = true
                resolve(`Already claim milestone ${stage}!`)
            }

            if (data.data) {
                success = true
                resolve(`Successfully to claim milestone ${stage}.`)
            }
        } catch (e) { }
    }
})

const openBox = (keyPair, auth) => new Promise(async (resolve) => {
    let success = false
    while (!success) {
        try {
            const data = await fetch(`https://odyssey-api-beta.sonic.game/user/rewards/mystery-box/build-tx`, {
                headers: {
                    ...defaultHeaders,
                    'authorization': auth
                }
            }).then(res => res.json())

            if (data.data) {
                const transactionBuffer = Buffer.from(data.data.hash, "base64")
                const transaction = sol.Transaction.from(transactionBuffer)
                transaction.partialSign(keyPair)
                const signature = await sendTransaction(transaction, keyPair)
                const open = await fetch('https://odyssey-api-beta.sonic.game/user/rewards/mystery-box/open', {
                    method: 'POST',
                    headers: {
                        ...defaultHeaders,
                        'authorization': auth
                    },
                    body: JSON.stringify({
                        'hash': signature
                    })
                }).then(res => res.json())

                if (open.data) {
                    success = true
                    resolve(open.data.amount)
                }
            }
        } catch (e) { }
    }
})

const getUserInfo = (auth) => new Promise(async (resolve) => {
    let success = false
    while (!success) {
        try {
            const data = await fetch('https://odyssey-api-beta.sonic.game/user/rewards/info', {
                headers: {
                    ...defaultHeaders,
                    'authorization': `${auth}`,
                }
            }).then(res => res.json())

            if (data.data) {
                success = true
                resolve(data.data)
            }
        } catch (e) { }
    }
})

const tgMessage = async (message) => {
    const token = TELEGRAM_BOT_TOKEN
    const chatid = TELEGRAM_BOT_CHATID
    const boturl = `https://api.telegram.org/bot${token}/sendMessage`

    await fetch(boturl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            chat_id: chatid,
            link_preview_options: { is_disabled: true },
            text: message,
        }),
    })
}

function extractAddressParts(address) {
    const firstThree = address.slice(0, 4)
    const lastFour = address.slice(-4)
    return `${firstThree}...${lastFour}`
}

(async () => {
    // GET PRIVATE KEY
    if (!process.env.PRIVATE_KEY) {
        throw new Error('Please fill PRIVATE_KEY in .env')
    }

    const listAccounts = process.env.PRIVATE_KEY.split("\n")
        .map((a) => a.trim())

    for (const privateKey of listAccounts) {
        if (privateKey.length > 0) {
            keypairs.push(getKeypairFromPrivateKey(privateKey))
        }
    }

    if (keypairs.length === 0) {
        throw new Error('Please fill at least 1 private key in private.txt')
    }

    // CUSTOM YOURS
    const addressCount = 100
    const amountToSend = 0.001 // in SOL
    const delayBetweenRequests = 5 // in seconds

    // DOING TASK FOR EACH PRIVATE KEY
    for (let index = 0; index < keypairs.length; index++) {
        if (keypairs[index] === undefined) {
            console.error(`Account ${index + 1} is not valid!`)
            continue
        }

        const publicKey = keypairs[index].publicKey.toBase58()
        const randomAddresses = generateRandomAddresses(addressCount)

        twisters.put(`${publicKey}`, {
            text: ` === ACCOUNT ${(index + 1)} ===
Address      : ${publicKey}
Points       : -
Mystery Box  : -
Status       : Getting user token...`
        })

        let token = await getLoginToken(keypairs[index])
        const initialInfo = await getUserInfo(token)
        let info = initialInfo

        // CHECK IN TASK
        twisters.put(`${publicKey}`, {
            text: ` === ACCOUNT ${(index + 1)} ===
Address      : ${publicKey}
Points       : ${info.ring}
Mystery Box  : ${info.ring_monitor}
Status       : Try to daily check in...`
        })

        const checkin = await dailyCheckin(keypairs[index], token)

        info = await getUserInfo(token)

        twisters.put(`${publicKey}`, {
            text: ` === ACCOUNT ${(index + 1)} ===
Address      : ${publicKey}
Points       : ${info.ring}
Mystery Box  : ${info.ring_monitor}
Status       : ${checkin}`
        })
        await delay(delayBetweenRequests)

        twisters.put(`${publicKey}`, {
            text: ` === ACCOUNT ${(index + 1)} ===
Address      : ${publicKey}
Points       : ${info.ring}
Mystery Box  : ${info.ring_monitor}
Status       : -`
        })

        // SENDING SOL
        for (const [i, address] of randomAddresses.entries()) {
            try {
                const toPublicKey = new sol.PublicKey(address)
                const transaction = new sol.Transaction().add(
                    sol.SystemProgram.transfer({
                        fromPubkey: keypairs[index].publicKey,
                        toPubkey: toPublicKey,
                        lamports: amountToSend * sol.LAMPORTS_PER_SOL,
                    })
                )
                await sendTransaction(transaction, keypairs[index])

                twisters.put(`${publicKey}`, {
                    text: ` === ACCOUNT ${(index + 1)} ===
Address      : ${publicKey}
Points       : ${info.ring}
Mystery Box  : ${info.ring_monitor}
Status       : [${(i + 1)}/${randomAddresses.length}] Successfully to sent ${amountToSend} SOL to ${address}`
                })

                await delay(delayBetweenRequests)
            } catch (error) {
                twisters.put(`${publicKey}`, {
                    text: ` === ACCOUNT ${(index + 1)} ===
Address      : ${publicKey}
Points       : ${info.ring}
Mystery Box  : ${info.ring_monitor}
Status       : [${(i + 1)}/${randomAddresses.length}] Failed to sent ${amountToSend} SOL to ${address}`
                })

                await delay(delayBetweenRequests)
            }
        }

        token = await getLoginToken(keypairs[index])

        // CLAIM MILESTONES
        twisters.put(`${publicKey}`, {
            text: ` === ACCOUNT ${(index + 1)} ===
Address      : ${publicKey}
Points       : ${info.ring}
Mystery Box  : ${info.ring_monitor}
Status       : Try to claim milestones...`
        })
        for (let i = 1; i <= 3; i++) {
            const milestones = await dailyMilestone(token, i)
            twisters.put(`${publicKey}`, {
                text: ` === ACCOUNT ${(index + 1)} ===
Address      : ${publicKey}
Points       : ${info.ring}
Mystery Box  : ${info.ring_monitor}
Status       : ${milestones}`
            })
            await delay(delayBetweenRequests)
        }

        info = await getUserInfo(token)
        let msg = `Earned ${(info.ring_monitor - initialInfo.ring_monitor)} Mystery Box\nYou have ${info.ring} Points and ${info.ring_monitor} Mystery Box now.`

        if (OPEN_BOX) {
            const totalBox = info.ring_monitor
            twisters.put(`${publicKey}`, {
                text: `=== ACCOUNT ${(index + 1)} ===
Address      : ${publicKey}
Points       : ${info.ring}
Mystery Box  : ${info.ring_monitor}
Status       : Preparing for open ${totalBox} mystery boxes...`
            })

            for (let i = 0; i < totalBox; i++) {
                const openedBox = await openBox(keypairs[index], token)
                info = await getUserInfo(token)
                twisters.put(`${publicKey}`, {
                    text: ` === ACCOUNT ${(index + 1)} ===
Address      : ${publicKey}
Points       : ${info.ring}
Mystery Box  : ${info.ring_monitor}
Status       : [${(i + 1)}/${totalBox}] You got ${openedBox} points!`
                })
                await delay(delayBetweenRequests)
            }

            info = await getUserInfo(token)
            msg = `Earned ${(info.ring - initialInfo.ring)} Points\nYou have ${info.ring} Points and ${info.ring_monitor} Mystery Box now.`
        }

        if (USE_TELEGRAM_BOT) {
            await tgMessage(`${extractAddressParts(publicKey)} | ${msg}`)
        }

        // YOUR POINTS AND MYSTERY BOX COUNT
        twisters.put(`${publicKey}`, {
            active: false,
            text: ` === ACCOUNT ${(index + 1)} ===
Address      : ${publicKey}
Points       : ${info.ring}
Mystery Box  : ${info.ring_monitor}
Status       : ${msg}`
        })
    }
})()
