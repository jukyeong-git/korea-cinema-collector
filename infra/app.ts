import { App, Stack, Duration, CfnOutput, DefaultStackSynthesizer } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "KoreaCinemaCollectorSeatsStack", {
  synthesizer: new DefaultStackSynthesizer({ qualifier: "krcinema" }),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-northeast-2" },
});
const tableArn = stack.formatArn({ service: "dynamodb", resource: "table", resourceName: "korea-cinema-alert" });
const seatsSwitch = "/korea-cinema-alert/prod/seats-alerts-enabled";
const scheduleSwitch = "/korea-cinema-alert/prod/schedule-alerts-enabled";
const parameters = ["/korea-cinema-alert/prod/telegram-bot-token", "/korea-cinema-alert/prod/telegram-seats-chat-id"];
const fn = new lambda.Function(stack, "Receiver", {
  functionName: "korea-cinema-alert-seats", runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64, memorySize: 256, timeout: Duration.seconds(30),
  handler: "handler.handler", code: lambda.Code.fromAsset("dist"),
  environment: { TABLE_NAME: "korea-cinema-alert", ALERTS_ENABLED: "true",
    NOTIFICATION_SWITCH_PARAMETER: seatsSwitch,
    TELEGRAM_BOT_TOKEN_PARAMETER: parameters[0], TELEGRAM_CHAT_ID_PARAMETER: parameters[1] },
});
fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:TransactWriteItems"], resources: [tableArn, `${tableArn}/index/*`] }));
fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameters"], resources: [...parameters, seatsSwitch].map(p => stack.formatArn({ service: "ssm", resource: "parameter", resourceName: p.slice(1) })) }));
const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(stack, "ExistingGitHubOidc", stack.formatArn({ service: "iam", region: "", resource: "oidc-provider", resourceName: "token.actions.githubusercontent.com" }));
const runner = new iam.Role(stack, "GitHubRunner", {
  roleName: "korea-cinema-collector-seats-github",
  assumedBy: new iam.OpenIdConnectPrincipal(provider, { StringEquals: {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    // This repository uses GitHub's immutable subject IDs (queried via the OIDC customization API).
    "token.actions.githubusercontent.com:sub": "repo:jukyeong-git@206012346/korea-cinema-collector@1373957479:ref:refs/heads/main",
  } }),
  maxSessionDuration: Duration.hours(1),
});
runner.addToPolicy(new iam.PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem"], resources: [tableArn],
  conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["STATE#seat_candidates", "SESSION#*", "SEATSTATE#*"] } } }));
runner.addToPolicy(new iam.PolicyStatement({ actions: ["dynamodb:PutItem"], resources: [tableArn],
  conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["STATE#seat_candidates"] } },
}));
fn.grantInvoke(runner);
new CfnOutput(stack, "GitHubRoleArn", { value: runner.roleArn });
new CfnOutput(stack, "FunctionName", { value: fn.functionName });

const scheduleParameters = [parameters[0], "/korea-cinema-alert/prod/telegram-chat-id"];
const scheduleReceiver = new lambda.Function(stack, "ScheduleReceiverTemp", {
  functionName: "korea-cinema-alert-schedule-temp", runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64, memorySize: 256, timeout: Duration.seconds(30),
  handler: "handler.handler", code: lambda.Code.fromAsset("dist-schedule"),
  environment: { TABLE_NAME: "korea-cinema-alert", ALERTS_ENABLED: "true",
    NOTIFICATION_SWITCH_PARAMETER: scheduleSwitch,
    TELEGRAM_BOT_TOKEN_PARAMETER: scheduleParameters[0], TELEGRAM_CHAT_ID_PARAMETER: scheduleParameters[1] },
});
scheduleReceiver.addToRolePolicy(new iam.PolicyStatement({
  actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:TransactWriteItems"],
  resources: [tableArn, `${tableArn}/index/*`],
}));
scheduleReceiver.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameters"],
  resources: [...scheduleParameters, scheduleSwitch].map(p => stack.formatArn({ service: "ssm", resource: "parameter", resourceName: p.slice(1) })),
}));
scheduleReceiver.grantInvoke(runner);
new CfnOutput(stack, "ScheduleTempFunctionName", { value: scheduleReceiver.functionName });
