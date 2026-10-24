//@category 0kay
//@description Decompile one function to C, framed by markers the agent can find.
//@keybinding
//@menupath
//@toolbar

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.symbol.SymbolTable;

public class DecompileFunction extends GhidraScript {

    private Function find(String target) {
        FunctionManager functions = currentProgram.getFunctionManager();
        if (target == null || target.isEmpty()) {
            // No argument: the entry point is the only sensible default.
            Address entry = currentProgram.getEntryPoint();
            return functions.getFunctionAt(entry);
        }

        // By address first: it is unambiguous.
        try {
            Address address = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(target);
            Function at = functions.getFunctionAt(address);
            if (at != null) return at;
        } catch (Exception ignored) {
            // Not an address; fall through to a name lookup.
        }

        for (Function function : functions.getFunctions(true)) {
            if (function.getName().equals(target)) return function;
        }
        SymbolTable symbols = currentProgram.getSymbolTable();
        SymbolIterator iterator = symbols.getSymbols(target);
        while (iterator.hasNext()) {
            Symbol symbol = iterator.next();
            Function at = functions.getFunctionAt(symbol.getAddress());
            if (at != null) return at;
        }
        return null;
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        String target = args.length > 0 ? args[0] : "";
        Function function = find(target);
        if (function == null) {
            println("0KAY-ERROR function not found: " + target);
            return;
        }

        DecompInterface decompiler = new DecompInterface();
        try {
            decompiler.openProgram(currentProgram);
            DecompileResults results = decompiler.decompileFunction(function, 90, monitor);
            if (results == null || !results.decompileCompleted() || results.getDecompiledFunction() == null) {
                println("0KAY-ERROR decompiler failed: " + (results == null ? "no result" : results.getErrorMessage()));
                return;
            }
            println("0KAY-C-BEGIN");
            println("// " + function.getName() + " @ " + function.getEntryPoint());
            println(results.getDecompiledFunction().getC());
            println("0KAY-C-END");
        } finally {
            decompiler.dispose();
        }
    }
}
