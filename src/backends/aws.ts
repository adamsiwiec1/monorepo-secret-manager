import type {
  SecretsManagerClient,
  SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";
import { importPeer } from "../errors";
import { DeletePolicy, EnvironmentConfig } from "../types";
import { SecretBackend, SecretPayload, SecretVersion } from "./types";

type AwsSdk = typeof import("@aws-sdk/client-secrets-manager");

export class AwsBackend implements SecretBackend {
  readonly provider = "aws" as const;

  constructor(
    private readonly client: SecretsManagerClient,
    private readonly sdk: AwsSdk,
    private readonly kmsKeyId?: string
  ) {}

  async get(name: string): Promise<SecretPayload> {
    const result = await this.client.send(
      new this.sdk.GetSecretValueCommand({ SecretId: name })
    );

    if (result.SecretBinary) {
      return { data: Buffer.from(result.SecretBinary as Uint8Array) };
    }
    if (result.SecretString) {
      return { data: Buffer.from(result.SecretString, "utf8") };
    }
    throw new Error(`No data found for secret ${name}`);
  }

  async put(name: string, payload: SecretPayload): Promise<void> {
    try {
      await this.client.send(
        new this.sdk.CreateSecretCommand({
          Name: name,
          SecretBinary: payload.data,
          KmsKeyId: this.kmsKeyId,
        })
      );
      console.error(`Created new secret ${name}`);
    } catch (error) {
      const nameOrMessage =
        (error as { name?: string }).name || (error as Error).message;
      if (
        !nameOrMessage.includes("ResourceExistsException") &&
        !nameOrMessage.includes("InvalidRequestException")
      ) {
        throw error;
      }

      await this.client.send(
        new this.sdk.PutSecretValueCommand({
          SecretId: name,
          SecretBinary: payload.data,
        })
      );
      console.error(`Updated secret ${name} with a new version`);
    }
  }

  async listVersions(name: string): Promise<SecretVersion[]> {
    const result = await this.client.send(
      new this.sdk.ListSecretVersionIdsCommand({
        SecretId: name,
        IncludeDeprecated: true,
      })
    );

    return (result.Versions || []).map((version) => ({
      id: version.VersionId || "",
      createdAt: version.CreatedDate,
      enabled: (version.VersionStages || []).length > 0,
    }));
  }

  async destroyVersions(name: string, policy: DeletePolicy): Promise<void> {
    if (policy.enabled === false) {
      return;
    }

    console.warn(
      `AWS Secrets Manager does not support destroying individual versions. Skipping cleanup for ${name}.`
    );
  }
}

export async function createAwsBackend(
  environment: EnvironmentConfig
): Promise<AwsBackend> {
  const sdk = await importPeer("aws", ["@aws-sdk/client-secrets-manager"], () =>
    import("@aws-sdk/client-secrets-manager")
  );

  if (!environment.region) {
    throw new Error('AWS provider requires "region"');
  }

  const config: SecretsManagerClientConfig = {
    region: environment.region,
  };

  if (environment.credentials?.profile) {
    process.env.AWS_PROFILE = environment.credentials.profile;
  }

  return new AwsBackend(
    new sdk.SecretsManagerClient(config),
    sdk,
    environment.kmsKeyId
  );
}
