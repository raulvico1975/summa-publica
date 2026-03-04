import { config } from './config.mjs';
import { getSocialIntegration } from './db.mjs';
import { decryptSecret } from './secret-crypto.mjs';

const META_API_BASE = 'https://graph.facebook.com/v22.0';

function toAbsoluteMediaUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) {
    return `${config.appBaseUrl.replace(/\/$/, '')}${raw}`;
  }
  return raw;
}

async function expectJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message || `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return data;
}

async function resolveMetaRuntime(post) {
  const orgId = String(post?.orgId || '').trim();
  if (orgId) {
    const integration = await getSocialIntegration('meta', { orgId });
    if (integration && integration.status === 'connected') {
      const pageToken = integration.pageAccessTokenEnc ? decryptSecret(integration.pageAccessTokenEnc) : '';
      return {
        facebookPageId: integration.facebookPageId || '',
        instagramBusinessAccountId: integration.instagramBusinessAccountId || '',
        facebookToken: pageToken || '',
        instagramToken: pageToken || '',
        source: 'integration'
      };
    }
  }

  return {
    facebookPageId: config.facebookPageId,
    instagramBusinessAccountId: config.instagramBusinessAccountId,
    facebookToken: config.facebookToken,
    instagramToken: config.instagramToken,
    source: 'config'
  };
}

async function publishFacebook(post) {
  const meta = await resolveMetaRuntime(post);
  if (!meta.facebookPageId || !meta.facebookToken) {
    throw new Error('Facebook no connectat per aquesta entitat.');
  }

  const params = new URLSearchParams({
    message: post.content,
    access_token: meta.facebookToken
  });

  const response = await fetch(`${META_API_BASE}/${encodeURIComponent(meta.facebookPageId)}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  const data = await expectJson(response);
  return {
    provider: 'facebook',
    id: data.id || null,
    raw: data
  };
}

async function publishInstagram(post) {
  const meta = await resolveMetaRuntime(post);
  if (!meta.instagramBusinessAccountId || !meta.instagramToken) {
    throw new Error('Instagram no connectat per aquesta entitat o pagina Meta sense compte d Instagram Business.');
  }

  const candidateUrls = Array.isArray(post.mediaUrls)
    ? post.mediaUrls.map((url) => toAbsoluteMediaUrl(url)).filter(Boolean)
    : [];
  const imageUrl = candidateUrls[0] || toAbsoluteMediaUrl(post.mediaUrl || config.instagramDefaultImageUrl);
  if (!imageUrl) {
    throw new Error('Instagram requereix mediaUrl o INSTAGRAM_DEFAULT_IMAGE_URL.');
  }

  const createParams = new URLSearchParams({
    image_url: imageUrl,
    caption: post.content,
    access_token: meta.instagramToken
  });

  const createResp = await fetch(`${META_API_BASE}/${encodeURIComponent(meta.instagramBusinessAccountId)}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: createParams
  });
  const createData = await expectJson(createResp);
  const creationId = createData.id;

  if (!creationId) {
    throw new Error('Instagram no ha retornat creation id.');
  }

  const publishParams = new URLSearchParams({
    creation_id: creationId,
    access_token: meta.instagramToken
  });

  const publishResp = await fetch(`${META_API_BASE}/${encodeURIComponent(meta.instagramBusinessAccountId)}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: publishParams
  });

  const publishData = await expectJson(publishResp);
  return {
    provider: 'instagram',
    id: publishData.id || creationId,
    raw: { createData, publishData }
  };
}

async function publishWhatsApp(post) {
  if (!config.whatsappPhoneNumberId || !config.whatsappToken) {
    throw new Error('WhatsApp no configurat (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN).');
  }

  const recipients = Array.isArray(post.whatsappRecipients) && post.whatsappRecipients.length > 0
    ? post.whatsappRecipients
    : config.whatsappRecipients;

  if (!recipients.length) {
    throw new Error('No hi ha recipients de WhatsApp configurats.');
  }

  const sent = [];
  for (const to of recipients) {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        preview_url: false,
        body: post.content
      }
    };

    const response = await fetch(`${META_API_BASE}/${encodeURIComponent(config.whatsappPhoneNumberId)}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsappToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await expectJson(response);
    sent.push({ to, id: data?.messages?.[0]?.id || null });
  }

  return {
    provider: 'whatsapp',
    id: sent[0]?.id || null,
    raw: { sent }
  };
}

export async function publishPost(post) {
  const channel = post.channel;
  if (channel === 'facebook') return publishFacebook(post);
  if (channel === 'instagram') return publishInstagram(post);
  if (channel === 'whatsapp') return publishWhatsApp(post);
  if (channel === 'meta') {
    const fb = await publishFacebook(post);
    const ig = await publishInstagram(post);
    return {
      provider: 'meta',
      id: fb.id || ig.id || null,
      raw: { facebook: fb.raw, instagram: ig.raw }
    };
  }
  throw new Error(`Canal no suportat: ${channel}`);
}
