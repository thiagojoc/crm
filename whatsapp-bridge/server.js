// Ponte entre o Evolution API (WhatsApp do Vinicius) e o CRM (Firestore).
// Recebe o webhook de mensagem recebida, extrai nome e telefone de quem
// mandou, e cria o lead direto na conta (workspace) configurada, sem
// precisar que o lead preencha nada.
//
// Variaveis de ambiente obrigatorias: ver .env.example
'use strict';

const express = require('express');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const CRM_WORKSPACE_ID = process.env.CRM_WORKSPACE_ID;
const SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
const DEFAULT_PIPELINE_ID = process.env.DEFAULT_PIPELINE_ID || 'pl-sdr';
const DEFAULT_STAGE_ID = process.env.DEFAULT_STAGE_ID || 'novo';
const DEFAULT_TAGS = (process.env.DEFAULT_TAGS || 'lead-whatsapp').split(',').map(s => s.trim()).filter(Boolean);

if(!WEBHOOK_SECRET || !CRM_WORKSPACE_ID){
  console.error('Faltou configurar WEBHOOK_SECRET e/ou CRM_WORKSPACE_ID no .env. Veja .env.example.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH)) });
const db = admin.firestore();
const crmDocRef = db.collection('crm_sjc').doc(CRM_WORKSPACE_ID);

const app = express();
app.use(express.json({ limit: '2mb' }));

function uid(prefix){ return (prefix||'x') + Date.now() + Math.floor(Math.random()*100000); }
function digitsOnly(str){ return String(str||'').replace(/\D/g,''); }

// mesma mascara usada no CRM (index.html: maskPhoneBR), pro telefone ficar
// com a cara igual a de um lead cadastrado manualmente.
function maskPhoneBR(raw){
  let d = digitsOnly(raw);
  if(!d) return '';
  if(!d.startsWith('55')) d = '55' + d;
  d = d.slice(0, 13);
  const ddd = d.slice(2, 4);
  const rest = d.slice(4);
  let out = '+55';
  if(ddd) out += ' (' + ddd;
  if(ddd.length === 2) out += ')';
  if(rest){
    out += ' ';
    out += rest.length > 4 ? (rest.slice(0, rest.length - 4) + '-' + rest.slice(-4)) : rest;
  }
  return out;
}

// o remoteJid vem como "5512999998888@s.whatsapp.net" (contato direto),
// "...-...@g.us" (grupo, ignorado) ou "status@broadcast" (ignorado).
function waNumberFromJid(jid){
  if(!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return null;
  const digits = digitsOnly(jid.split('@')[0]);
  return digits || null;
}

// o corpo da mensagem muda de formato dependendo do tipo (texto puro,
// resposta a outra mensagem, legenda de foto etc.); tenta os formatos mais
// comuns e cai num texto generico se nao reconhecer (ainda assim cria o
// lead, so sem o texto da mensagem).
function extractMessageText(message){
  if(!message) return '';
  return message.conversation
    || (message.extendedTextMessage && message.extendedTextMessage.text)
    || (message.imageMessage && message.imageMessage.caption)
    || (message.videoMessage && message.videoMessage.caption)
    || '';
}

function splitName(pushName){
  const name = String(pushName || '').trim();
  if(!name) return { firstName: 'Lead WhatsApp', lastName: '' };
  const parts = name.split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// le o documento da conta, confere se ja existe um contato com esse mesmo
// waNumber (lead que ja mandou mensagem antes, ou que ja foi cadastrado na
// mao) e, se nao existir, adiciona o contato e a oportunidade na primeira
// etapa do pipeline padrao. Roda numa transacao pra nao correr risco de
// perder uma edicao feita ao mesmo tempo direto no CRM.
async function createLeadIfNew(waNumber, firstName, lastName, firstMessage){
  return db.runTransaction(async (t) => {
    const snap = await t.get(crmDocRef);
    if(!snap.exists) throw new Error('Workspace ' + CRM_WORKSPACE_ID + ' nao encontrado em crm_sjc.');
    const data = snap.data();
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    const opportunities = Array.isArray(data.opportunities) ? data.opportunities : [];

    if(contacts.some(c => c.waNumber === waNumber)){
      return { created: false };
    }

    const now = new Date().toISOString();
    const contact = {
      id: uid('c'), firstName, lastName, office: '', instagram: '',
      phone: maskPhoneBR(waNumber), waNumber, email: '', address: '',
      tags: DEFAULT_TAGS.slice(),
      note: firstMessage ? ('Primeira mensagem no WhatsApp: ' + firstMessage) : 'Lead recebido automaticamente pelo WhatsApp.',
      createdAt: now
    };
    const opportunity = {
      id: uid('o'), contactId: contact.id, pipelineId: DEFAULT_PIPELINE_ID, stageId: DEFAULT_STAGE_ID,
      outcome: 'aberto', createdAt: now, stageChangedAt: now
    };

    t.update(crmDocRef, {
      contacts: contacts.concat([contact]),
      opportunities: opportunities.concat([opportunity])
    });
    return { created: true, contact };
  });
}

app.post('/webhook/:secret', async (req, res) => {
  if(req.params.secret !== WEBHOOK_SECRET){
    return res.status(401).json({ error: 'secret invalido' });
  }
  // responde logo pro Evolution API nao ficar re-tentando o mesmo evento;
  // o processamento acontece depois, de forma assincrona.
  res.status(200).json({ ok: true });

  try {
    const body = req.body || {};
    const items = Array.isArray(body.data) ? body.data : [body.data || body];
    for(const item of items){
      const key = item && item.key;
      if(!key || key.fromMe) continue;
      const waNumber = waNumberFromJid(key.remoteJid);
      if(!waNumber) continue;
      const { firstName, lastName } = splitName(item.pushName);
      const text = extractMessageText(item.message);
      const result = await createLeadIfNew(waNumber, firstName, lastName, text);
      if(result.created){
        console.log('Lead criado:', firstName, lastName, waNumber);
      }
    }
  } catch(err){
    console.error('Falha ao processar webhook:', err);
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log('crm-whatsapp-bridge ouvindo na porta ' + PORT));
