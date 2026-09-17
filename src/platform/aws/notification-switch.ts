import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
const ssm = new SSMClient({});
// Read on every invocation; warm Lambda instances must not cache operator switches.
export async function readNotificationSwitch(): Promise<boolean> {
  const name = process.env.NOTIFICATION_SWITCH_PARAMETER;
  if (!name) throw Error("NOTIFICATION_SWITCH_PARAMETER is required");
  const response = await ssm.send(new GetParametersCommand({ Names: [name] }));
  const value = response.Parameters?.find(p => p.Name === name)?.Value;
  if (response.InvalidParameters?.length || (value !== "true" && value !== "false")) {
    throw Error("Missing or invalid notification switch; refusing delivery");
  }
  return value === "true";
}
