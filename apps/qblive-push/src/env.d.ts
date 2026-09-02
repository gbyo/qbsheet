/**
 * The push gateway's bindings and secrets.
 *
 * # Why this service exists at all
 *
 * An APNs provider key authenticates as *the QBSheet Live app*. It cannot be handed to arbitrary
 * Director installations or to a tournament's own Cloudflare account, so remote Live Activity
 * updates need one trusted component that holds it. This is that component and nothing more: it
 * does not carry tournament data, it is not the QBLive backend, and if it is down, everything
 * except Lock Screen updates and APNs notifications keeps working.
 *
 * See `docs/QBLIVE.md#13-apple-push`.
 */

declare namespace Cloudflare {
  interface Env {
    /** One object per publication: subscriptions, channels, dedup state. */
    PUSH_PUBLICATION: DurableObjectNamespace<import('./publication').PushPublication>;
    /**
     * The APNs provider-token coordinator.
     *
     * A singleton. Apple rate-limits provider-token *generation*, so exactly one object mints and
     * caches the JWT and every sender asks it. See `credential.ts`.
     */
    APNS_CREDENTIAL: DurableObjectNamespace<import('./credential').ApnsCredential>;
    /** Absorbs tournament bursts so hundreds of publications cannot hammer APNs directly. */
    PUSH_QUEUE: Queue<import('./types').PushJob>;

    /** The `.p8` contents, PEM-encoded. A Worker secret. Never logged, never returned. */
    APNS_PRIVATE_KEY?: string;
    APNS_KEY_ID?: string;
    APNS_TEAM_ID?: string;
    /** The full app's bundle id. Broadcast channels are per app, per environment. */
    APNS_BUNDLE_ID?: string;
    /** The App Clip's bundle id, which is a different APNs topic. */
    APNS_CLIP_BUNDLE_ID?: string;
    /** `production` or `sandbox`. Channels cannot be shared across environments. */
    APNS_ENVIRONMENT?: string;
    /**
     * An external channel manager, used only if the deployed edge turns out not to reach Apple's
     * channel-management port. See `docs/QBLIVE_PUSH_PROTOTYPE.md#5`.
     */
    EXTERNAL_CHANNEL_MANAGER_URL?: string;
    EXTERNAL_CHANNEL_MANAGER_TOKEN?: string;
  }
}

interface Env extends Cloudflare.Env {}
