// The execution request must belong to node.exe, not only to its GUI helper.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <node_api.h>

static HANDLE request = NULL;
static bool systemRequired = false, executionRequired = false, threadRequired = false;
static EXECUTION_STATE previousThreadState = 0;
static DWORD lastError = 0;

static void Release() {
  if (threadRequired) SetThreadExecutionState(previousThreadState | ES_CONTINUOUS);
  threadRequired = false;
  if (request && request != INVALID_HANDLE_VALUE) {
    if (executionRequired) PowerClearRequest(request, PowerRequestExecutionRequired);
    if (systemRequired) PowerClearRequest(request, PowerRequestSystemRequired);
    CloseHandle(request);
  }
  request = NULL;
  systemRequired = executionRequired = false;
}
static napi_value State(napi_env env, napi_callback_info) {
  napi_value result, value;
  napi_create_object(env, &result);
  const char* names[] = {"system", "execution", "thread", "protected"};
  const bool values[] = {systemRequired, executionRequired, threadRequired,
                        systemRequired && executionRequired && threadRequired};
  for (int i = 0; i < 4; i++) {
    napi_get_boolean(env, values[i], &value);
    napi_set_named_property(env, result, names[i], value);
  }
  napi_create_uint32(env, lastError, &value);
  napi_set_named_property(env, result, "errorCode", value);
  return result;
}
static napi_value Acquire(napi_env env, napi_callback_info info) {
  if (systemRequired && executionRequired && threadRequired) return State(env, info);
  Release();
  lastError = 0;
  REASON_CONTEXT context = {};
  context.Version = POWER_REQUEST_CONTEXT_VERSION;
  context.Flags = POWER_REQUEST_CONTEXT_SIMPLE_STRING;
  context.Reason.SimpleReasonString = const_cast<LPWSTR>(L"ふろじゅんの予約と通知を、画面消灯中も継続しています。");
  request = PowerCreateRequest(&context);
  if (!request || request == INVALID_HANDLE_VALUE) lastError = GetLastError();
  else {
    systemRequired = PowerSetRequest(request, PowerRequestSystemRequired) != FALSE;
    if (!systemRequired) lastError = GetLastError();
    executionRequired = PowerSetRequest(request, PowerRequestExecutionRequired) != FALSE;
    if (!executionRequired && !lastError) lastError = GetLastError();
    if (systemRequired && executionRequired) {
      previousThreadState = SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
      threadRequired = previousThreadState != 0;
      if (!threadRequired && !lastError) lastError = GetLastError();
    }
  }
  if (!systemRequired || !executionRequired || !threadRequired) {
    if (!lastError) lastError = ERROR_GEN_FAILURE;
    Release();
  }
  return State(env, info);
}
static napi_value Clear(napi_env env, napi_callback_info) {
  Release();
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static void Cleanup(void*) { Release(); }
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"acquire", NULL, Acquire, NULL, NULL, NULL, napi_default, NULL},
    {"release", NULL, Clear, NULL, NULL, NULL, napi_default, NULL},
    {"state", NULL, State, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, 3, methods);
  napi_value version;
  napi_create_uint32(env, 1, &version);
  napi_set_named_property(env, exports, "version", version);
  napi_add_env_cleanup_hook(env, Cleanup, NULL);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
