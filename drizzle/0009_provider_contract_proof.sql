ALTER TABLE "bot_connections" DROP CONSTRAINT "bot_provider_valid";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_provider_valid";--> statement-breakpoint
ALTER TABLE "connection_routes" DROP CONSTRAINT "route_provider_valid";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_channel_valid";--> statement-breakpoint
ALTER TABLE "person_identities" DROP CONSTRAINT "identities_provider_valid";--> statement-breakpoint
ALTER TABLE "bot_connections" ADD CONSTRAINT "bot_provider_valid" CHECK ("bot_connections"."provider" IN ('telegram', 'fake'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_provider_valid" CHECK ("channels"."provider" IN ('telegram', 'fake'));--> statement-breakpoint
ALTER TABLE "connection_routes" ADD CONSTRAINT "route_provider_valid" CHECK ("connection_routes"."provider" IN ('telegram', 'fake'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_channel_valid" CHECK ("notifications"."channel" IN ('telegram','fake','email'));--> statement-breakpoint
ALTER TABLE "person_identities" ADD CONSTRAINT "identities_provider_valid" CHECK ("person_identities"."provider" IN ('telegram', 'fake'));