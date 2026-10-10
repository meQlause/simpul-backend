CREATE TABLE "aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"person_id" uuid NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"confidence" numeric(4, 3),
	CONSTRAINT "aliases_alias_length" CHECK (char_length("aliases"."alias") BETWEEN 1 AND 80),
	CONSTRAINT "aliases_source_valid" CHECK ("aliases"."source" IN ('manual','ai_inferred','human_confirmed')),
	CONSTRAINT "aliases_confidence_valid" CHECK ("aliases"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "bot_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"connection_name" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"bot_username" text NOT NULL,
	"bot_name" text NOT NULL,
	"token_secret_ref" text NOT NULL,
	"webhook_secret_ref" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"webhook_checked_at" timestamp with time zone,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "bot_provider_valid" CHECK ("bot_connections"."provider" = 'telegram'),
	CONSTRAINT "bot_name_length" CHECK (char_length("bot_connections"."connection_name") BETWEEN 1 AND 80),
	CONSTRAINT "bot_status_valid" CHECK ("bot_connections"."status" IN ('pending','ready','needs_action','degraded'))
);
--> statement-breakpoint
CREATE TABLE "channel_connection_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bot_connection_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"purpose" text NOT NULL,
	"candidate_chat_id" text,
	"candidate_title" text,
	"candidate_chat_type" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "ccs_purpose_valid" CHECK ("channel_connection_sessions"."purpose" IN ('identify_group','receive_check')),
	CONSTRAINT "ccs_expiry_valid" CHECK ("channel_connection_sessions"."expires_at" > "channel_connection_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "channel_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"bot_connection_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"credential_version" integer NOT NULL,
	"checks" jsonb NOT NULL,
	"status" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"error_code" text,
	CONSTRAINT "cv_status_valid" CHECK ("channel_verifications"."status" IN ('pass','fail','pending')),
	CONSTRAINT "cv_expiry_valid" CHECK ("channel_verifications"."expires_at" > "channel_verifications"."checked_at")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"bot_connection_id" uuid NOT NULL,
	"provider_chat_id" text NOT NULL,
	"provider_chat_type" text,
	"provider_chat_title" text,
	"member_count" integer,
	"display_name" text NOT NULL,
	"class" text DEFAULT 'external' NOT NULL,
	"primary_language" text DEFAULT 'auto' NOT NULL,
	"connection_status" text DEFAULT 'draft' NOT NULL,
	"monitored" boolean DEFAULT false NOT NULL,
	"privacy_mode_ok" boolean DEFAULT false NOT NULL,
	"visible_indicator_message_id" text,
	"verified_at" timestamp with time zone,
	"monitoring_started_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"config_version" integer DEFAULT 1 NOT NULL,
	"verified_config_version" integer,
	"authorization_ack_at" timestamp with time zone,
	"authorization_ack_by" uuid,
	"last_error_code" text,
	"likely_domains" uuid[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "channels_provider_valid" CHECK ("channels"."provider" = 'telegram'),
	CONSTRAINT "channels_chat_type_valid" CHECK ("channels"."provider_chat_type" IN ('group','supergroup')),
	CONSTRAINT "channels_class_valid" CHECK ("channels"."class" IN ('internal','external')),
	CONSTRAINT "channels_language_valid" CHECK ("channels"."primary_language" IN ('id','en','auto')),
	CONSTRAINT "channels_status_valid" CHECK ("channels"."connection_status" IN ('draft','verified','active','paused','needs_action')),
	CONSTRAINT "channels_display_name_length" CHECK (char_length("channels"."display_name") BETWEEN 1 AND 120),
	CONSTRAINT "channels_monitored_only_when_active" CHECK (NOT "channels"."monitored" OR ("channels"."connection_status" = 'active' AND "channels"."authorization_ack_at" IS NOT NULL AND "channels"."monitoring_started_at" IS NOT NULL AND "channels"."visible_indicator_message_id" IS NOT NULL AND ("channels"."provider" <> 'telegram' OR "channels"."provider_chat_type" IN ('group','supergroup'))))
);
--> statement-breakpoint
CREATE TABLE "config_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"record_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
CREATE TABLE "connection_routes" (
	"bot_connection_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	CONSTRAINT "route_provider_valid" CHECK ("connection_routes"."provider" = 'telegram')
);
--> statement-breakpoint
CREATE TABLE "corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"op_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"corrected_by" uuid NOT NULL,
	"correction_type" text NOT NULL,
	"previous_state" jsonb NOT NULL,
	CONSTRAINT "corrections_type_valid" CHECK ("corrections"."correction_type" = 'not_this_work')
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"thread_id" uuid,
	"rule_id" uuid,
	"recipient_person_id" uuid,
	"notification_id" uuid,
	CONSTRAINT "decisions_kind_valid" CHECK ("decisions"."kind" IN ('routing','work','queue','digest'))
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recipient_person_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "display_id_counters" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain_id" uuid PRIMARY KEY NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"type" text NOT NULL,
	"weight" numeric(6, 4) NOT NULL,
	"confidence" numeric(4, 3),
	"created_by" text NOT NULL,
	CONSTRAINT "edges_created_by_valid" CHECK ("edges"."created_by" IN ('manual','ai_inferred','human_confirmed'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"endpoint" text NOT NULL,
	"fingerprint" "bytea" NOT NULL,
	"response" jsonb
);
--> statement-breakpoint
CREATE TABLE "label_rule_matches" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_rule_matches_label_id_rule_id_pk" PRIMARY KEY("label_id","rule_id")
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"thread_id" uuid,
	"op_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid,
	"domain_hint" text,
	"type" text NOT NULL,
	"tense" text NOT NULL,
	"magnitude" numeric(18, 2),
	"currency" char(3),
	"actor_from" uuid,
	"actor_to" uuid,
	"evidence_message_ids" uuid[] NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"vocab_version" integer NOT NULL,
	"routed_at" timestamp with time zone,
	CONSTRAINT "labels_type_valid" CHECK ("labels"."type" IN ('progress','resolution','blocker')),
	CONSTRAINT "labels_tense_valid" CHECK ("labels"."tense" IN ('sudah_terjadi','rencana','kondisional')),
	CONSTRAINT "labels_evidence_required" CHECK (cardinality("labels"."evidence_message_ids") >= 1),
	CONSTRAINT "labels_confidence_valid" CHECK ("labels"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "labels_currency_with_magnitude" CHECK (("labels"."magnitude" IS NULL) = ("labels"."currency" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "mail_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"username" text NOT NULL,
	"from_address" text NOT NULL,
	"password_secret_ref" text NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "mail_port_valid" CHECK ("mail_connections"."port" BETWEEN 1 AND 65535)
);
--> statement-breakpoint
CREATE TABLE "message_thread_link" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	CONSTRAINT "message_thread_link_message_id_thread_id_role_pk" PRIMARY KEY("message_id","thread_id","role"),
	CONSTRAINT "mtl_role_valid" CHECK ("message_thread_link"."role" IN ('genesis','state_change','mention','supporting'))
);
--> statement-breakpoint
CREATE TABLE "messages_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"provider_msg_id" text NOT NULL,
	"sender_external_id" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"body_safe" text DEFAULT '' NOT NULL,
	"media_ref" text,
	"reply_to_id" text,
	"thread_ref" text,
	"server_ts" timestamp with time zone NOT NULL,
	"received_ts" timestamp with time zone NOT NULL,
	"origin" text DEFAULT 'user' NOT NULL,
	"supersedes" uuid,
	CONSTRAINT "messages_origin_valid" CHECK ("messages_raw"."origin" IN ('user','simpul'))
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"thread_id" uuid,
	"rule_id" uuid,
	"recipient_person_id" uuid NOT NULL,
	"kind" text DEFAULT 'update' NOT NULL,
	"channel" text NOT NULL,
	"body_rendered" text NOT NULL,
	"digest_id" uuid,
	"held_until" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"corrected_at" timestamp with time zone,
	CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" IN ('update','reminder','escalation','correction')),
	CONSTRAINT "notifications_channel_valid" CHECK ("notifications"."channel" IN ('telegram','email')),
	CONSTRAINT "notifications_not_sent_and_cancelled" CHECK (NOT ("notifications"."sent_at" IS NOT NULL AND "notifications"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "open_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_ids" uuid[] NOT NULL,
	"channel_id" uuid NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"answered_by" uuid,
	"answer" text,
	CONSTRAINT "oq_candidates_valid" CHECK (cardinality("open_questions"."thread_ids") BETWEEN 1 AND 3),
	CONSTRAINT "oq_expiry_valid" CHECK ("open_questions"."expires_at" > "open_questions"."asked_at")
);
--> statement-breakpoint
CREATE TABLE "orphans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recoverable" boolean DEFAULT true NOT NULL,
	"cluster_key" text,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"level" text DEFAULT 'staff' NOT NULL,
	"manager_id" uuid,
	"availability" text DEFAULT 'available' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"auth_user_id" text,
	CONSTRAINT "people_name_length" CHECK (char_length("people"."name") BETWEEN 1 AND 120),
	CONSTRAINT "people_level_valid" CHECK ("people"."level" IN ('staff','executive')),
	CONSTRAINT "people_availability_valid" CHECK ("people"."availability" IN ('available','leave')),
	CONSTRAINT "people_manager_not_self" CHECK ("people"."manager_id" <> "people"."id")
);
--> statement-breakpoint
CREATE TABLE "person_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text,
	"handle" text,
	CONSTRAINT "identities_provider_valid" CHECK ("person_identities"."provider" = 'telegram'),
	CONSTRAINT "identities_identifier_required" CHECK ("person_identities"."external_id" IS NOT NULL OR "person_identities"."handle" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"budget_per_hour" integer DEFAULT 6 NOT NULL,
	"quiet_start" time(0) DEFAULT '21:00' NOT NULL,
	"quiet_end" time(0) DEFAULT '07:00' NOT NULL,
	"digest_time" time(0) NOT NULL,
	"hold_seconds" integer DEFAULT 60 NOT NULL,
	"escalation_limit" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "policies_budget_valid" CHECK ("policies"."budget_per_hour" BETWEEN 1 AND 50),
	CONSTRAINT "policies_hold_nonnegative" CHECK ("policies"."hold_seconds" >= 0),
	CONSTRAINT "policies_escalation_nonnegative" CHECK ("policies"."escalation_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "progress_markers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"message_id" uuid,
	"type" text NOT NULL,
	CONSTRAINT "markers_type_valid" CHECK ("progress_markers"."type" IN ('progress','resolution','blocker'))
);
--> statement-breakpoint
CREATE TABLE "provider_updates" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bot_connection_id" uuid NOT NULL,
	"update_id" text NOT NULL,
	CONSTRAINT "provider_updates_bot_connection_id_update_id_pk" PRIMARY KEY("bot_connection_id","update_id")
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"label_id" uuid,
	"detected_text" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "review_kind_valid" CHECK ("review_items"."kind" IN ('unrouted','alias','category'))
);
--> statement-breakpoint
CREATE TABLE "role_members" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text DEFAULT 'member' NOT NULL,
	CONSTRAINT "role_members_role_id_person_id_kind_pk" PRIMARY KEY("role_id","person_id","kind"),
	CONSTRAINT "role_members_kind_valid" CHECK ("role_members"."kind" IN ('member','backup'))
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"name" text NOT NULL,
	"team" text DEFAULT 'Other' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "roles_name_length" CHECK (char_length("roles"."name") BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain_id" uuid NOT NULL,
	"condition_text" text NOT NULL,
	"event_type" text NOT NULL,
	"recipient_role_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"history_mode" text DEFAULT 'digest' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_fired_at" timestamp with time zone,
	CONSTRAINT "rules_name_length" CHECK (char_length("rules"."name") BETWEEN 1 AND 100),
	CONSTRAINT "rules_condition_length" CHECK (char_length("rules"."condition_text") BETWEEN 1 AND 300),
	CONSTRAINT "rules_event_type_valid" CHECK ("rules"."event_type" IN ('new','progress','resolution','blocker')),
	CONSTRAINT "rules_urgency_valid" CHECK ("rules"."urgency" IN ('normal','high')),
	CONSTRAINT "rules_history_mode_valid" CHECK ("rules"."history_mode" IN ('digest','future'))
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	CONSTRAINT "secrets_purpose_valid" CHECK ("secrets"."purpose" IN ('bot_token','webhook_secret','mail_password','database_url')),
	CONSTRAINT "secrets_nonce_length" CHECK (octet_length("secrets"."nonce") = 12)
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"audience" text NOT NULL,
	"body" text NOT NULL,
	"editable" boolean DEFAULT true NOT NULL,
	CONSTRAINT "templates_body_length" CHECK (char_length("templates"."body") <= 300),
	CONSTRAINT "templates_audience_valid" CHECK ("templates"."audience" IN ('internal','external')),
	CONSTRAINT "templates_placeholders_allowed" CHECK (regexp_replace("templates"."body", '{{(work_id|customer|summary)}}', '', 'g') !~ '{{')
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_id" text NOT NULL,
	"status" text NOT NULL,
	"domain_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"customer_label" text,
	"customer_node_id" uuid,
	"summary" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owner_person_id" uuid,
	"next_step" text,
	"parent_thread_id" uuid,
	"genesis_confidence" numeric(4, 3) NOT NULL,
	"historical" boolean DEFAULT false NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"closure_kind" text,
	"closure_reason" text,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	CONSTRAINT "threads_status_valid" CHECK ("threads"."status" IN ('tentative','active','completed','cancelled','archived')),
	CONSTRAINT "threads_closure_kind_valid" CHECK ("threads"."closure_kind" IN ('completed','cancelled','outside_chat')),
	CONSTRAINT "threads_closure_matches_status" CHECK (("threads"."status" IN ('tentative','active')) = ("threads"."closed_at" IS NULL) AND ("threads"."closed_at" IS NULL) = ("threads"."closure_kind" IS NULL)),
	CONSTRAINT "threads_tentative_expires" CHECK ("threads"."status" <> 'tentative' OR "threads"."expires_at" IS NOT NULL),
	CONSTRAINT "threads_reason_length" CHECK ("threads"."closure_reason" IS NULL OR char_length("threads"."closure_reason") BETWEEN 5 AND 300)
);
--> statement-breakpoint
CREATE TABLE "thresholds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"scope_id" uuid,
	"key" text NOT NULL,
	"value" numeric(12, 4) NOT NULL,
	CONSTRAINT "thresholds_uq" UNIQUE NULLS NOT DISTINCT("workspace_id","scope","scope_id","key"),
	CONSTRAINT "thresholds_scope_valid" CHECK ("thresholds"."scope" IN ('workspace','domain'))
);
--> statement-breakpoint
CREATE TABLE "unit_embeddings" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"unit_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(768) NOT NULL,
	"model" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit_messages" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	CONSTRAINT "unit_messages_unit_id_message_id_pk" PRIMARY KEY("unit_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"sender_id" uuid,
	"text" text NOT NULL,
	"explicit_ids" text[] DEFAULT '{}' NOT NULL,
	"triage_class" text,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"injection_suspected" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'text' NOT NULL,
	"confidence_multiplier" numeric(3, 2) DEFAULT '1.00' NOT NULL,
	"ts_first" timestamp with time zone NOT NULL,
	"ts_last" timestamp with time zone NOT NULL,
	CONSTRAINT "units_triage_valid" CHECK ("units"."triage_class" IN ('EVENT','QUERY','NOISE')),
	CONSTRAINT "units_source_valid" CHECK ("units"."source" IN ('text','transcript')),
	CONSTRAINT "units_confidence_valid" CHECK ("units"."confidence_multiplier" BETWEEN 0 AND 1),
	CONSTRAINT "units_time_order" CHECK ("units"."ts_last" >= "units"."ts_first")
);
--> statement-breakpoint
CREATE TABLE "vocab_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"examples" text[] DEFAULT '{}' NOT NULL,
	"id_prefix" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "vocab_name_length" CHECK (char_length("vocab_domains"."name") BETWEEN 1 AND 80),
	CONSTRAINT "vocab_description_length" CHECK (char_length("vocab_domains"."description") <= 300),
	CONSTRAINT "vocab_prefix_valid" CHECK ("vocab_domains"."id_prefix" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "workspace_databases" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_name" text NOT NULL,
	"timezone" text NOT NULL,
	"admin_auth_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"url_secret_ref" uuid,
	"host" text,
	"port" integer,
	"database_name" text,
	"schema_version" text,
	"availability_ack_at" timestamp with time zone,
	"availability_ack_by" text,
	"connected_at" timestamp with time zone,
	"unreachable_since" timestamp with time zone,
	"probe_streak" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wsdb_name_length" CHECK (char_length("workspace_databases"."workspace_name") BETWEEN 1 AND 80),
	CONSTRAINT "wsdb_port_valid" CHECK ("workspace_databases"."port" BETWEEN 1 AND 65535),
	CONSTRAINT "wsdb_ack_before_connection" CHECK ("workspace_databases"."url_secret_ref" IS NULL OR "workspace_databases"."availability_ack_at" IS NOT NULL),
	CONSTRAINT "wsdb_status_valid" CHECK ("workspace_databases"."status" IN ('pending','connected','unreachable','migration_failed')),
	CONSTRAINT "wsdb_status_matches_state" CHECK (("workspace_databases"."status" = 'pending') = ("workspace_databases"."url_secret_ref" IS NULL) AND ("workspace_databases"."status" = 'unreachable') = ("workspace_databases"."unreachable_since" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "workspace_keys" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"master_key_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"descriptor" text,
	"timezone" text NOT NULL,
	"vocab_version" integer DEFAULT 1 NOT NULL,
	"admin_person_id" uuid,
	"onboarding_completed_at" timestamp with time zone,
	CONSTRAINT "workspaces_name_length" CHECK (char_length("workspaces"."name") BETWEEN 1 AND 80),
	CONSTRAINT "workspaces_vocab_version_positive" CHECK ("workspaces"."vocab_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "bot_connections" ADD CONSTRAINT "bot_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "bot_connections" ADD CONSTRAINT "bot_connections_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "channel_connection_sessions" ADD CONSTRAINT "channel_connection_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "channel_connection_sessions" ADD CONSTRAINT "channel_connection_sessions_bot_connection_id_bot_connections_id_fk" FOREIGN KEY ("bot_connection_id") REFERENCES "public"."bot_connections"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "channel_connection_sessions" ADD CONSTRAINT "channel_connection_sessions_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "channel_verifications" ADD CONSTRAINT "channel_verifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "channel_verifications" ADD CONSTRAINT "channel_verifications_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "channel_verifications" ADD CONSTRAINT "channel_verifications_bot_connection_id_bot_connections_id_fk" FOREIGN KEY ("bot_connection_id") REFERENCES "public"."bot_connections"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_authorization_ack_by_people_id_fk" FOREIGN KEY ("authorization_ack_by") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_bot_same_ws" FOREIGN KEY ("workspace_id","bot_connection_id") REFERENCES "public"."bot_connections"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "config_audit" ADD CONSTRAINT "config_audit_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "config_audit" ADD CONSTRAINT "config_audit_actor_id_people_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "connection_routes" ADD CONSTRAINT "connection_routes_workspace_id_workspace_databases_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace_databases"("workspace_id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_corrected_by_people_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_recipient_person_id_people_id_fk" FOREIGN KEY ("recipient_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_recipient_person_id_people_id_fk" FOREIGN KEY ("recipient_person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "display_id_counters" ADD CONSTRAINT "display_id_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "display_id_counters" ADD CONSTRAINT "display_id_counters_domain_id_vocab_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."vocab_domains"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_from_id_nodes_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_to_id_nodes_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "label_rule_matches" ADD CONSTRAINT "label_rule_matches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "label_rule_matches" ADD CONSTRAINT "label_rule_matches_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "label_rule_matches" ADD CONSTRAINT "label_rule_matches_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_domain_id_vocab_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."vocab_domains"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_actor_from_people_id_fk" FOREIGN KEY ("actor_from") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_actor_to_people_id_fk" FOREIGN KEY ("actor_to") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "mail_connections" ADD CONSTRAINT "mail_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "message_thread_link" ADD CONSTRAINT "message_thread_link_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "message_thread_link" ADD CONSTRAINT "message_thread_link_message_id_messages_raw_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages_raw"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "message_thread_link" ADD CONSTRAINT "message_thread_link_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "messages_raw" ADD CONSTRAINT "messages_raw_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "messages_raw" ADD CONSTRAINT "messages_raw_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "messages_raw" ADD CONSTRAINT "messages_raw_supersedes_messages_raw_id_fk" FOREIGN KEY ("supersedes") REFERENCES "public"."messages_raw"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_person_id_people_id_fk" FOREIGN KEY ("recipient_person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_answered_by_people_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "orphans" ADD CONSTRAINT "orphans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "orphans" ADD CONSTRAINT "orphans_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_manager_id_people_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "person_identities" ADD CONSTRAINT "person_identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "person_identities" ADD CONSTRAINT "person_identities_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "progress_markers" ADD CONSTRAINT "progress_markers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "progress_markers" ADD CONSTRAINT "progress_markers_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "progress_markers" ADD CONSTRAINT "progress_markers_message_id_messages_raw_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages_raw"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "provider_updates" ADD CONSTRAINT "provider_updates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "provider_updates" ADD CONSTRAINT "provider_updates_bot_connection_id_bot_connections_id_fk" FOREIGN KEY ("bot_connection_id") REFERENCES "public"."bot_connections"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_resolved_by_people_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "role_members" ADD CONSTRAINT "role_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "role_members" ADD CONSTRAINT "role_members_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "role_members" ADD CONSTRAINT "role_members_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_domain_id_vocab_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."vocab_domains"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_recipient_role_id_roles_id_fk" FOREIGN KEY ("recipient_role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_workspace_id_workspace_keys_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace_keys"("workspace_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_domain_id_vocab_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."vocab_domains"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_customer_node_id_nodes_id_fk" FOREIGN KEY ("customer_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_parent_thread_id_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_closed_by_people_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "thresholds" ADD CONSTRAINT "thresholds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "thresholds" ADD CONSTRAINT "thresholds_scope_id_vocab_domains_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."vocab_domains"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "unit_embeddings" ADD CONSTRAINT "unit_embeddings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "unit_embeddings" ADD CONSTRAINT "unit_embeddings_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "unit_messages" ADD CONSTRAINT "unit_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "unit_messages" ADD CONSTRAINT "unit_messages_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "unit_messages" ADD CONSTRAINT "unit_messages_message_id_messages_raw_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages_raw"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_sender_id_people_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "vocab_domains" ADD CONSTRAINT "vocab_domains_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "workspace_databases" ADD CONSTRAINT "workspace_databases_url_secret_ref_secrets_id_fk" FOREIGN KEY ("url_secret_ref") REFERENCES "public"."secrets"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_admin_person_id_people_id_fk" FOREIGN KEY ("admin_person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "aliases_ws_alias_uq" ON "aliases" USING btree ("workspace_id",lower("alias"));--> statement-breakpoint
CREATE UNIQUE INDEX "bot_account_uq" ON "bot_connections" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_ws_provider_uq" ON "bot_connections" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "ccs_hash_uq" ON "channel_connection_sessions" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "cv_channel_time_idx" ON "channel_verifications" USING btree ("channel_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "channels_chat_uq" ON "channels" USING btree ("workspace_id","provider","provider_chat_id");--> statement-breakpoint
CREATE INDEX "channels_ws_status_idx" ON "channels" USING btree ("workspace_id","connection_status");--> statement-breakpoint
CREATE INDEX "audit_record_idx" ON "config_audit" USING btree ("workspace_id","table_name","record_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "route_account_uq" ON "connection_routes" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "corrections_op_idx" ON "corrections" USING btree ("op_id");--> statement-breakpoint
CREATE INDEX "decisions_list_idx" ON "decisions" USING btree ("workspace_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "edges_from_idx" ON "edges" USING btree ("workspace_id","from_id","type","weight" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "edges_to_idx" ON "edges" USING btree ("workspace_id","to_id","type","weight" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idem_uq" ON "idempotency_keys" USING btree ("workspace_id","endpoint","key");--> statement-breakpoint
CREATE INDEX "lrm_rule_time_idx" ON "label_rule_matches" USING btree ("rule_id","matched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "labels_unrouted_idx" ON "labels" USING btree ("workspace_id","routed_at") WHERE "labels"."routed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_op_uq" ON "labels" USING btree ("op_id");--> statement-breakpoint
CREATE INDEX "labels_thread_idx" ON "labels" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_ws_uq" ON "mail_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mtl_message_idx" ON "message_thread_link" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_uq" ON "messages_raw" USING btree ("workspace_id","channel_id","provider_msg_id");--> statement-breakpoint
CREATE INDEX "messages_sweep_idx" ON "messages_raw" USING btree ("workspace_id","channel_id","server_ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notif_due_idx" ON "notifications" USING btree ("workspace_id","held_until") WHERE "notifications"."sent_at" IS NULL AND "notifications"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notif_budget_idx" ON "notifications" USING btree ("recipient_person_id","sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notif_rule_idx" ON "notifications" USING btree ("rule_id","sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "notif_one_per_label_uq" ON "notifications" USING btree ("label_id","recipient_person_id","kind") WHERE "notifications"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "oq_channel_day_idx" ON "open_questions" USING btree ("channel_id","asked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orphans_open_idx" ON "orphans" USING btree ("workspace_id","created_at") WHERE "orphans"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "people_ws_name_idx" ON "people" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "people_auth_user_uq" ON "people" USING btree ("auth_user_id") WHERE "people"."auth_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "identities_person_provider_uq" ON "person_identities" USING btree ("person_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_external_uq" ON "person_identities" USING btree ("workspace_id","provider","external_id") WHERE "person_identities"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "policies_ws_uq" ON "policies" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "markers_thread_ts_idx" ON "progress_markers" USING btree ("thread_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "review_open_idx" ON "review_items" USING btree ("workspace_id","kind","detected_at" DESC NULLS LAST) WHERE "review_items"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "role_members_person_idx" ON "role_members" USING btree ("person_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_ws_key_uq" ON "roles" USING btree ("workspace_id","role_key");--> statement-breakpoint
CREATE INDEX "rules_ws_active_idx" ON "rules" USING btree ("workspace_id","active","priority" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "templates_uq" ON "templates" USING btree ("workspace_id","key","audience");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_display_uq" ON "threads" USING btree ("workspace_id","display_id");--> statement-breakpoint
CREATE INDEX "threads_candidates_idx" ON "threads" USING btree ("workspace_id","channel_id","status","last_activity_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "threads_expiry_idx" ON "threads" USING btree ("workspace_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "threads_list_idx" ON "threads" USING btree ("workspace_id","last_activity_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "unit_embeddings_hnsw_idx" ON "unit_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "unit_messages_msg_idx" ON "unit_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "units_ws_time_idx" ON "units" USING btree ("workspace_id","ts_last" DESC NULLS LAST) WHERE "units"."triage_class" <> 'NOISE';--> statement-breakpoint
CREATE UNIQUE INDEX "vocab_ws_name_uq" ON "vocab_domains" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "vocab_ws_prefix_uq" ON "vocab_domains" USING btree ("workspace_id","id_prefix") WHERE "vocab_domains"."id_prefix" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wsdb_admin_uq" ON "workspace_databases" USING btree ("admin_auth_user_id");--> statement-breakpoint
CREATE INDEX "wsdb_status_idx" ON "workspace_databases" USING btree ("status");