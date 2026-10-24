//@category 0kay
//@description Emit functions and strings as one JSON block, framed by markers the agent can find.

import ghidra.app.script.GhidraScript;
import ghidra.program.model.data.DataType;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;

public class ExportFacts extends GhidraScript {

    private static String esc(String value) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.toString();
    }

    @Override
    public void run() throws Exception {
        StringBuilder json = new StringBuilder();
        json.append("{\"functions\":[");

        FunctionManager functions = currentProgram.getFunctionManager();
        boolean first = true;
        int count = 0;
        for (Function function : functions.getFunctions(true)) {
            if (!first) json.append(",");
            first = false;
            json.append("{\"name\":\"").append(esc(function.getName()))
                .append("\",\"entry\":\"").append(function.getEntryPoint())
                .append("\",\"size\":").append(function.getBody().getNumAddresses())
                .append("}");
            if (++count >= 20000) break;
        }
        json.append("],\"strings\":[");

        // Defined string data only: the listing already decoded them, so this is
        // what the program thinks a string is, not every printable byte run.
        DataIterator data = currentProgram.getListing().getDefinedData(true);
        first = true;
        count = 0;
        while (data.hasNext() && count < 5000) {
            Data item = data.next();
            if (item == null || item.getValue() == null) continue;
            DataType type = item.getDataType();
            if (type == null) continue;
            String name = type.getName().toLowerCase();
            if (!name.startsWith("string") && !name.startsWith("unicode") && !name.startsWith("term")) continue;
            String value = item.getValue().toString();
            if (value == null || value.isEmpty() || value.length() > 500) continue;
            if (!first) json.append(",");
            first = false;
            json.append("\"").append(esc(value)).append("\"");
            count++;
        }
        json.append("],\"truncated\":").append(count >= 5000).append("}");

        println("0KAY-JSON-BEGIN");
        println(json.toString());
        println("0KAY-JSON-END");
    }
}
