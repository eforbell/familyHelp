'use strict';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';

async function callOpenAI(messages, schema, maxTokens = 2000) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_completion_tokens: maxTokens,
      response_format: {
        type:        'json_schema',
        json_schema: { name: schema.name, strict: true, schema: schema.schema },
      },
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];

  if (choice?.finish_reason === 'length') {
    // Try to use what we got -- structured JSON may still be parseable
    try {
      return JSON.parse(choice.message.content);
    } catch {
      throw new Error('OpenAI response was truncated and could not be parsed');
    }
  }

  return JSON.parse(choice.message.content);
}

// ── MagicHelp schema ──────────────────────────────────────────────────────────

const MAGIC_HELP_SCHEMA = {
  name: 'magic_help',
  schema: {
    type: 'object',
    properties: {
      suggestion: {
        type: 'string',
        description: 'The helpful response. Clear, step-by-step where appropriate. For homework, teach the concept without giving the answer directly.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'How confident you are this will resolve the issue.',
      },
      needs_human: {
        type: 'boolean',
        description: 'True if this really needs a human (safety, physical task, complex judgment).',
      },
      human_reason: {
        type: 'string',
        description: 'If needs_human is true, brief reason why. Otherwise empty string.',
      },
    },
    required: ['suggestion', 'confidence', 'needs_human', 'human_reason'],
    additionalProperties: false,
  },
};

/**
 * Generate a MagicHelp suggestion for a ticket.
 * @param {object} ticket - { title, description, category_name }
 * @param {string} householdPrompt - from app_config magic_help_prompt
 */
async function generateMagicHelp(ticket, householdPrompt) {
  const systemContent = [
    householdPrompt,
    '',
    'You are helping a family member with their request.',
    'Category: ' + (ticket.category_name || 'General'),
    '',
    'Rules:',
    '- For IT/tech: give clear troubleshooting steps numbered 1, 2, 3.',
    '- For homework: explain the concept, show how to approach it, but do NOT give the final answer. Teaching, not cheating.',
    '- For house maintenance: practical advice, but flag anything involving electricity, plumbing, gas, or structural work as needs_human.',
    '- For chores/errands: be helpful but these usually need a human to physically do them -- set needs_human=true.',
    '- Keep it concise and friendly. This is a family, not a corporate helpdesk.',
    '- Never suggest anything dangerous.',
    '- Keep responses under 500 words. Be thorough but concise.',
  ].join('\n');

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: `Title: ${ticket.title}\n\nDescription: ${ticket.description}` },
  ];

  return callOpenAI(messages, MAGIC_HELP_SCHEMA, 16000);
}

/**
 * Follow-up on a MagicHelp conversation.
 * @param {object} ticket - { title, description, category_name }
 * @param {string} previousSuggestion - the AI's prior response
 * @param {string} followUp - the user's follow-up question
 * @param {string} householdPrompt - from app_config magic_help_prompt
 */
async function followUpMagicHelp(ticket, previousSuggestion, followUp, householdPrompt) {
  const systemContent = [
    householdPrompt,
    '',
    'You are continuing to help a family member with their request.',
    'Category: ' + (ticket.category_name || 'General'),
    '',
    'Rules:',
    '- For IT/tech: give clear troubleshooting steps numbered 1, 2, 3.',
    '- For homework: explain the concept, show how to approach it, but do NOT give the final answer. Teaching, not cheating. Give one more hint if asked.',
    '- For house maintenance: practical advice, but flag anything involving electricity, plumbing, gas, or structural work as needs_human.',
    '- Keep it concise and friendly. This is a family, not a corporate helpdesk.',
    '- Never suggest anything dangerous.',
    '- Keep responses under 500 words. Be thorough but concise.',
    '- Build on your previous response -- don\'t repeat everything, just address the follow-up.',
  ].join('\n');

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: `Title: ${ticket.title}\n\nDescription: ${ticket.description}` },
    { role: 'assistant', content: JSON.stringify({ suggestion: previousSuggestion, confidence: 'high', needs_human: false, human_reason: '' }) },
    { role: 'user', content: followUp },
  ];

  return callOpenAI(messages, MAGIC_HELP_SCHEMA, 32000);
}

module.exports = { generateMagicHelp, followUpMagicHelp, hasOpenAI: () => !!OPENAI_API_KEY };
