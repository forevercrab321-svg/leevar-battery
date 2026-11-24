class Provider:
    def complete(self, response, available_functions):
        stop_reason = response.get("stopReason")
        if stop_reason == "max_tokens":
            logging.warning("Response truncated due to max_tokens limit")
        for block in response["content"]:
            if "toolUse" in block:
                result = self._handle_tool_execution(
                    function_name=block["toolUse"]["name"],
                    function_args=block["toolUse"].get("input", {}),
                )
        return result
