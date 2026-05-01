import type { ProviderKind } from '@tday/shared';

interface Props {
  kind: ProviderKind;
  size?: number;
  className?: string;
}

/**
 * Inline SVG marks for each provider — kept simple/abstract so we don't ship
 * trademarked logo files. Shapes are intentionally evocative.
 */
export function ProviderLogo({ kind, size = 18, className }: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    className,
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
  };

  switch (kind) {
    case 'deepseek':
      return (
        <svg {...common}>
          <path
            d="M2 14c2-3 5-5 9-5 3 0 5 1 7 3l4-2-2 4c1 1 1 3 0 5-2 2-5 3-9 3-5 0-9-3-9-8z"
            fill="#4d6bfe"
          />
          <circle cx="17" cy="12" r="0.9" fill="#fff" />
        </svg>
      );
    case 'openai':
      return (
        <svg {...common}>
          <path
            d="M21 10.4a5.4 5.4 0 0 0-.5-4.5 5.5 5.5 0 0 0-5.9-2.6 5.4 5.4 0 0 0-9.1 2 5.5 5.5 0 0 0-3.6 2.6 5.4 5.4 0 0 0 .7 6.4 5.4 5.4 0 0 0 .5 4.5 5.5 5.5 0 0 0 5.9 2.6 5.4 5.4 0 0 0 9.1-2 5.5 5.5 0 0 0 3.6-2.6 5.4 5.4 0 0 0-.7-6.4z"
            stroke="#10a37f"
            strokeWidth="1.4"
          />
        </svg>
      );
    case 'anthropic':
      return (
        <svg {...common}>
          <rect x="2" y="2" width="20" height="20" rx="4" fill="#cc785c" />
          <path
            d="M9 17 12 8l3 9h-2l-.6-2h-1.8l-.6 2H9zm2.7-3.6h1.2L12 11l-.6 2.4z"
            fill="#fff"
          />
        </svg>
      );
    case 'google':
      return (
        <svg {...common}>
          <path d="M12 4 L20 20 L4 20 Z" fill="#4285f4" />
          <circle cx="12" cy="14" r="2.4" fill="#fff" />
          <circle cx="12" cy="14" r="1.2" fill="#ea4335" />
        </svg>
      );
    case 'xai':
      return (
        <svg {...common}>
          <rect x="2" y="2" width="20" height="20" rx="4" fill="#000" />
          <path d="M6 6 L18 18 M6 18 L18 6" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'groq':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" fill="#f55036" />
          <path d="M8 8 L16 16 M8 16 L16 8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'mistral':
      return (
        <svg {...common}>
          <rect x="2" y="4" width="4" height="16" fill="#000" />
          <rect x="6" y="4" width="4" height="4" fill="#ffd800" />
          <rect x="10" y="4" width="4" height="16" fill="#000" />
          <rect x="14" y="8" width="4" height="4" fill="#fa520f" />
          <rect x="18" y="4" width="4" height="16" fill="#000" />
          <rect x="14" y="16" width="4" height="4" fill="#e10500" />
        </svg>
      );
    case 'moonshot':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" fill="#1a1a2e" />
          <path d="M16 8a6 6 0 1 1-4 11 6 6 0 0 0 4-11z" fill="#e7e9ee" />
        </svg>
      );
    case 'cerebras':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" stroke="#ff5b30" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="5" stroke="#ff5b30" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="1.5" fill="#ff5b30" />
        </svg>
      );
    case 'together':
      return (
        <svg {...common}>
          <circle cx="8" cy="12" r="4" fill="#0f6fff" />
          <circle cx="16" cy="12" r="4" fill="#7c3aed" opacity="0.85" />
        </svg>
      );
    case 'fireworks':
      return (
        <svg {...common}>
          <path d="M12 3 L14 10 L21 12 L14 14 L12 21 L10 14 L3 12 L10 10 Z" fill="#6720ff" />
        </svg>
      );
    case 'zai':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="4" fill="#1d4ed8" />
          <path
            d="M8 8h8l-7 8h7"
            stroke="#fff"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
    case 'qwen':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="4" fill="#615ced" />
          <path
            d="M7 8 12 5 17 8 17 14 12 17 7 14Z M12 5 V17"
            stroke="#fff"
            strokeWidth="1.4"
            fill="none"
          />
        </svg>
      );
    case 'volcengine':
      return (
        <svg {...common}>
          <path d="M3 19 L9 7 L13 13 L17 6 L21 19 Z" fill="#ff5500" />
        </svg>
      );
    case 'minimax':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="4" fill="#0a0a23" />
          <path
            d="M6 16 V8 L9 12 L12 8 V16 M14 8 H18 M16 8 V16"
            stroke="#fff"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'stepfun':
      return (
        <svg {...common}>
          <path
            d="M4 18 H8 V14 H12 V10 H16 V6 H20"
            stroke="#0ea5e9"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'openrouter':
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="3" fill="#a855f7" />
          <circle cx="19" cy="6" r="2.2" fill="#38bdf8" />
          <circle cx="19" cy="18" r="2.2" fill="#38bdf8" />
          <path
            d="M7.5 11 17 6.5M7.5 13 17 17.5"
            stroke="#a855f7"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'ollama':
      return (
        <svg {...common}>
          <path
            d="M12 3a4 4 0 0 0-4 4v3H6a3 3 0 0 0-3 3v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a3 3 0 0 0-3-3h-2V7a4 4 0 0 0-4-4z"
            fill="#000"
            stroke="#000"
          />
          <circle cx="9" cy="14" r="1.2" fill="#fff" />
          <circle cx="15" cy="14" r="1.2" fill="#fff" />
        </svg>
      );
    case 'lmstudio':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="12" rx="2" stroke="#a78bfa" strokeWidth="1.5" />
          <path d="M9 20 H15 M12 17 V20" stroke="#a78bfa" strokeWidth="1.5" strokeLinecap="round" />
          <path
            d="M8 11 L11 13 L8 15"
            stroke="#a78bfa"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M13 15 H16" stroke="#a78bfa" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case 'vercel-ai-gateway':
      return (
        <svg {...common}>
          <path d="M12 4 L22 20 H2 Z" fill="#000" />
        </svg>
      );
    case 'litellm':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="4" fill="#0ea5a4" />
          <path
            d="M8 8 V16 H11 M14 8 H18 M16 8 V16"
            stroke="#fff"
            strokeWidth="1.6"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      );
    case 'nvidia':
      return (
        <svg {...common}>
          <rect x="2" y="2" width="20" height="20" rx="3" fill="#76b900" />
          <path d="M5 10 V16 M5 10 Q5 7 8 7 Q11 7 11 10 V16 M11 10 V16" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M13 7 H19 V10 H13 V13 H19 V16 H13" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      );
    case 'huggingface':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" fill="#ff9d00" />
          <circle cx="9" cy="10" r="1.2" fill="#fff" />
          <circle cx="15" cy="10" r="1.2" fill="#fff" />
          <path d="M9 14 Q12 17 15 14" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'perplexity':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="4" fill="#1f1f2f" />
          <path d="M7 8 L12 12 L17 8 M12 12 V16 M7 16 H17" stroke="#20c7b0" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      );
    case 'bedrock':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="4" fill="#232f3e" />
          <path d="M12 6 L18 10 V14 L12 18 L6 14 V10 Z" stroke="#ff9900" strokeWidth="1.5" fill="none" />
          <circle cx="12" cy="12" r="2" fill="#ff9900" />
        </svg>
      );
    case 'sglang':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="12" rx="2" stroke="#6366f1" strokeWidth="1.5" />
          <path d="M9 20 H15 M12 17 V20" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M7 9 L12 12 L17 9 M12 12 V15" stroke="#6366f1" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'vllm':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="12" rx="2" stroke="#ec4899" strokeWidth="1.5" />
          <path d="M9 20 H15 M12 17 V20" stroke="#ec4899" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M7 9 L12 15 L17 9" stroke="#ec4899" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'custom':
    default:
      return (
        <svg {...common}>
          <rect
            x="3"
            y="3"
            width="18"
            height="18"
            rx="4"
            stroke="#a1a1aa"
            strokeWidth="1.5"
            strokeDasharray="3 3"
          />
          <path
            d="M8 12h8M12 8v8"
            stroke="#a1a1aa"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}
